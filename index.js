const { readFileSync, createWriteStream, createReadStream } = require('fs')
const { client_id, client_secret, redirect_uris } = JSON.parse(readFileSync('./credentials.json').toString()).web

const TelegramBot = require('node-telegram-bot-api')
const bot = new TelegramBot(botId, { polling: true })
let msgId

const { google } = require('googleapis')
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])
let drive

const { join } = require('path')

const redis = require('redis')
const redisClient = redis.createClient({
    port: 6379,
    host: '127.0.0.1'
})

redisClient.on('error', e => {
    console.log('REDIS ERROR')
    console.log(e)
})

require('http').createServer((req, res) => {
    if (/(.+)callback(.+)/.test(req.url)) {
        // const { parse } = require('url')
        // const code = parse(req.url, true).query
        // console.log(code)
        oauth2Client.getToken(require('url').parse(req.url, true).query, (e, t) => {
            if (e) {
                console.log(e)
                msgId && bot.sendMessage(msgId, "Failed to get token! Try again later")
            }
            else {
                oauth2Client.setCredentials(t)

                redisClient.hmset(msgId, "token", JSON.stringify(t), (e, r) => {
                    if (e) {
                        console.log(e)
                    }
                    else {
                        console.log(r)
                    }
                })

                msgId && bot.sendMessage(msgId, "Successfully logged in")
                drive = google.drive({ version: 'v3', auth: oauth2Client })
            }
        })
        res.writeHead(200, {
            "Content-Type": "text/html"
        }).end("You can close this tab now")
    }
    else {
        res.writeHead(500, {
            "Content-Type": "text/html"
        }).end("Try again later")
    }
}).listen(5000)

bot.onText(/\/auth/, (msg, match) => {
    sendAuthLink(msg.chat.id)
})

bot.onText(/\/list/, async (msg, match) => {
    if (drive) {
        listDrive(msg.chat.id)
    }
    else {
        redisClient.hget(msg.chat.id, "token", (e, t) => {
            if (e) {
                console.log('REDIS GET ERROR')
                console.log(e)
            }
            else {
                if (t) {
                    oauth2Client.setCredentials(JSON.parse(t))
                    drive = google.drive({ version: 'v3', auth: oauth2Client })
                    listDrive(msg.chat.id)
                }
                else {
                    sendAuthLink(msg.chat.id)
                }
            }
        })
    }
})

bot.on('callback_query', msg => {
    if (drive) {
        downloadFile(msg.message.chat.id, msg.data)
    } else {
        sendAuthLink()
    }
})

bot.on('document', msg => {
    // console.log(msg)
    uploadFile(msg.chat.id, msg.document)
})

bot.on(/\/check/, (msg, match) => {
    if (drive) {
        bot.sendMessage(msg.chat.id, 'DRIVE SET')
    }
    else {
        bot.sendMessage(msg.chat.id, 'DRIVE NOT SET')
    }
    redisClient.hget(msg.chat.id, "token", (e, t) => {
        if (e) {
            bot.sendMessage(msg.chat.id, 'DB ERROR')
            console.log(e)
        }
        else {
            if (t) {
                bot.sendMessage(msg.chat.id, 'AUTHORIZED')
            }
            else {
                bot.sendMessage(msg.chat.id, 'UNAUTHORIZED')
            }
        }
    })
})

function sendAuthLink(chatId) {
    msgId = chatId
    bot.sendMessage(chatId, 'Open this link and allow', {
        reply_markup: {
            inline_keyboard: [[{
                text: 'Authorize',
                url: oauth2Client.generateAuthUrl({
                    scope: 'https://www.googleapis.com/auth/drive'
                })
            }]]
        }
    })
}

async function listDrive(chatId) {
    return new Promise(async (resolve, reject) => {
        try {
            const res = await drive.files.list()
            // console.log(res.data.files)
            bot.sendMessage(chatId, 'FILES', {
                reply_markup: {
                    inline_keyboard: res.data.files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder').map(f => {
                        redisClient.hmset(f.id, "id", f.id, "name", f.name, "mimeType", f.mimeType, (e, r) => {
                            if (e) {
                                console.log(e)
                            }
                            else {
                                redisClient.expire(f.id, 3600)
                            }
                        })
                        return [{ text: f.name, callback_data: f.id }]
                    })
                }
            })
            resolve()
        } catch (e) {
            console.log(e)
            sendAuthLink(chatId)
            reject()
        }
    })
}

async function downloadFile(chatId, fileId) {
    redisClient.hgetall(fileId, (error, file) => {
        if (error) {
            console.log(error)
            bot.sendMessage(chatId, 'Error getting file ID')
        }
        if (!file) {
            bot.sendMessage(chatId, 'Session expired! /list ')
        }
        else {
            try {
                bot.sendMessage(chatId, 'Downloading file')
                const fileStream = createWriteStream('./temp/' + file.name)
                drive.files.get({
                    fileId: file.id,
                    alt: 'media'
                }, { responseType: 'stream' }).then(res => {
                    res.data.on('end', () => {
                        console.log(file.mimeType)
                        console.log(join(__dirname, 'temp', file.name))
                        const readstream = createReadStream(join(__dirname, 'temp', file.name))
                        switch (true) {
                            case /image/.test(file.mimeType): {
                                bot.sendAudio(chatId, readstream)
                                break
                            }
                            case /application/.test(file.mimeType): {
                                bot.sendDocument(chatId, readstream)
                                break
                            }
                            case /video/.test(file.mimeType): {
                                bot.sendVideo(chatId, readstream)
                                break
                            }
                            case /image/.test(file.mimeType): {
                                bot.sendPhoto(chatId, readstream)
                                break
                            }
                            default: {
                                bot.sendDocument(chatId, readstream)
                            }
                        }
                    }).on('error', (e => {
                        console.log(e)
                        bot.sendMessage(chatId, 'Error getting file')
                    })).pipe(fileStream)
                })
            }
            catch (e) {
                console.log('DOWNLOAD ERROR')
                console.log(e)
            }
        }
    })
}

async function uploadFile(chatId, file) {
    if (drive) {
        const path = await bot.downloadFile(file.file_id, './tempdown', {})
        drive.files.create({
            resource: {
                name: file.file_name
            },
            media: {
                mimeType: file.mime_type,
                body: createReadStream('./' + path)
            },
            fields: 'id'
        }, (e, f) => {
            console.log(chatId)
            if (e) {
                bot.sendMessage(msg.chat.id, 'Error Uploading file')
            }
            else {
                bot.sendMessage(msg.chat.id, 'Uploaded')
            }
        })
    }
    else {
        sendAuthLink()
    }
}