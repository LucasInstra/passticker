// Envia figurinha animada direto pelo PC, sem usar o botão "Nova figurinha" do Web.
// Uso:
//   node send.js figurinhas/gato-24fps.webp 5511999999999
//   node send.js figurinhas/gato-24fps.webp 5511999999999 --code   (1º pareamento)
// Sessão salva em auth/ — só pareia 1x.
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcodeTerm from 'qrcode-terminal'
import QRCode from 'qrcode'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const DIR = dirname(fileURLToPath(import.meta.url))
const [,, file, to, flag] = process.argv
if (!file || !to) {
  console.log('Uso: node send.js <figurinha.webp> <numero-só-dígitos> [--code]')
  process.exit(1)
}
const USE_CODE = flag === '--code'
const num = String(to).replace(/\D/g, '')
const AUTH = join(DIR, 'auth')
await mkdir(AUTH, { recursive: true }) // baileys não cria a pasta sozinho
const { state, saveCreds } = await useMultiFileAuthState(AUTH)
const sock = makeWASocket({ auth: state, printQRInTerminal: false })

if (USE_CODE && !state.creds.registered) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let code = null
  for (let i = 1; i <= 6 && !code; i++) {
    try {
      await sleep(4000)
      code = await sock.requestPairingCode(num)
    } catch (e) {
      console.log(`tentativa ${i}/6 falhou, tentando de novo...`)
    }
  }
  if (!code) {
    console.log('Falha ao pedir código: sem conexão. Confira a internet e tente de novo.')
    process.exit(1)
  }
  console.log(`CÓDIGO DE PAREAMENTO: ${code}`)
  console.log('No celular: WhatsApp > Aparelhos conectados > Conectar aparelho > Conectar com número de telefone > digite o código')
}

sock.ev.on('creds.update', saveCreds)
sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
  if (qr && !USE_CODE) {
    qrcodeTerm.generate(qr, { small: true })
    await QRCode.toFile(join(DIR, 'qr.png'), qr, { width: 400, margin: 2 })
    console.log('QR salvo — abra e escaneie (vale por ~30s, gera outro se expirar)')
  }
  if (connection === 'open') {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    const buf = await readFile(file)
    // WebP animado vai como sticker animado de verdade
    await sock.sendMessage(jid, { sticker: buf })
    console.log(`Figurinha enviada p/ ${jid} ✅`)
    process.exit(0)
  }
  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode
    if (code !== DisconnectReason.loggedOut) {
      console.log('Reconectando...')
    } else {
      console.log('Sessão expirada, pareie de novo com --code')
      process.exit(1)
    }
  }
})
