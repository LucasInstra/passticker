// Interface local do Passticker — envia figurinha animada direto pelo PC.
// Um celular por vez (igual WhatsApp Web): pareia, usa, e "Trocar de número" p/ próxima pessoa.
// Roda: npm start -> http://localhost:8000 | Na rede: npm run lan
import { createServer } from 'node:http'
import { readFile, writeFile, readdir, stat, mkdir, rename, rm, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { patchSoundStickerProto, buildSoundStickerMessage } from './sound-sticker.js'

// figurinha com som: injeta o campo 26 (audioMessage) no encoder antes de qualquer envio
patchSoundStickerProto()

const require = createRequire(import.meta.url)
const FFMPEG = require('ffmpeg-static')
const FFPROBE = require('ffprobe-static').path
const pexec = promisify(execFile)

const PORT = Number(process.env.PORT) || 8000
const DIR = dirname(fileURLToPath(import.meta.url))
const AUTH = join(DIR, 'auth')
const FIG = join(DIR, 'figurinhas')
const MAX_BYTES = 500 * 1024

// log em arquivo p/ diagnóstico (não depende da janela do console)
const LOGF = join(DIR, 'atividade.log')
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' ')}`
  console.log(line)
  appendFile(LOGF, line + '\n').catch(() => {})
}
async function rotateLog() {
  try {
    const s = await stat(LOGF)
    if (s.size > 2 * 1024 * 1024) await rename(LOGF, join(DIR, 'atividade.anterior.log')).catch(() => {})
  } catch {}
}

// Migra layouts antigos (conta única ./auth ou multi-conta accounts.json) -> sessão única
async function migrate() {
  if (existsSync(join(DIR, 'accounts.json'))) {
    if (existsSync(join(DIR, 'auth-principal')) && !existsSync(AUTH)) {
      await rename(join(DIR, 'auth-principal'), AUTH).catch(() => {})
    }
    for (const f of await readdir(join(DIR, 'figurinhas', 'principal')).catch(() => [])) {
      if (f.endsWith('.webp')) await rename(join(DIR, 'figurinhas', 'principal', f), join(FIG, f)).catch(() => {})
    }
    await rm(join(DIR, 'figurinhas', 'principal'), { recursive: true, force: true }).catch(() => {})
    for (const f of await readdir(DIR).catch(() => [])) {
      if (/^auth-(.+)$/.test(f) && f !== 'auth') await rm(join(DIR, f), { recursive: true, force: true }).catch(() => {})
    }
    await rm(join(DIR, 'accounts.json'), { force: true }).catch(() => {})
  }
  await mkdir(FIG, { recursive: true }).catch(() => {})
}

let sock = null
let me = null
let status = 'off' // off | espera | on
let registered = false
let started = false
let pairBusy = false
let gen = 0                 // geração da conexão (evita evento de socket antigo)
let reconnectTimer = null
let reconnectTries = 0
let realCloseAt = 0         // p/ desistir de reconectar em loop
let qrReady = false         // socket pronto p/ parear (WhatsApp mandou QR)

function phoneOf(jid) {
  const m = String(jid || '').match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/)
  return m ? m[1] : ''
}

// socket vivo? basta não ter sido fechado (nosso handler zera ao fechar)
function wsAlive(s) {
  return !!s
}

function scheduleReconnect(ms) {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (sock) return
    ensureSock().catch(() => {})
  }, ms)
}

// ---------- WhatsApp (uma sessão por vez) ----------
async function ensureSock() {
  // NUNCA destrói um socket vivo: durante o pareamento ele PRECISA continuar de pé
  if (sock && wsAlive(sock)) return sock
  if (sock) { try { sock.end(undefined) } catch {} sock = null }
  await mkdir(AUTH, { recursive: true }) // baileys não cria a pasta sozinho
  let st = await useMultiFileAuthState(AUTH)
  // sessão meio-pareada (tem "me" mas não está registrada) faz o WhatsApp responder 401.
  // Nesse estado não dá pra pedir código: começa limpo.
  if (!st.state.creds.registered && (st.state.creds.me || st.state.creds.account)) {
    log('sessão inconsistente detectada — descartando p/ parear limpo')
    await rm(AUTH, { recursive: true, force: true }).catch(() => {})
    await mkdir(AUTH, { recursive: true })
    st = await useMultiFileAuthState(AUTH)
  }
  const { state, saveCreds } = st
  registered = !!state.creds.registered
  const my = ++gen
  qrReady = false
  const s = makeWASocket({ auth: state, printQRInTerminal: false })
  sock = s
  status = 'espera'
  me = null
  started = true
  s.ev.on('creds.update', (c) => { if (c.registered) registered = true; saveCreds() })
  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (my !== gen) return // evento de socket antigo, ignora
    if (qr) {
      qrReady = true // só agora é seguro pedir pairing code
      return
    }
    if (connection === 'open') {
      status = 'on'
      me = s.user?.id || null
      registered = true
      reconnectTries = 0
      qrReady = false
      log('conexão aberta:', me)
      return
    }
    if (connection === 'close') {
      status = 'off'
      me = null
      sock = null
      realCloseAt = Date.now()
      const code = lastDisconnect?.error?.output?.statusCode
      log('conexão fechada. código:', code, 'motivo:', lastDisconnect?.error?.message || '')
      if (code === DisconnectReason.loggedOut) {
        await rm(AUTH, { recursive: true, force: true }).catch(() => {})
        registered = false
        reconnectTries = 0
        return
      }
      // 515 = WhatsApp pediu reinício p/ CONCLUIR o login após o pareamento.
      // Sem código = QR expirou/fechamento amigável: precisa reabrir p/ poder parear.
      const restart = code === DisconnectReason.restartRequired || code === 428 || code === 408 || code === 503
      const semCodigo = code === undefined || code === null
      const wait = code === DisconnectReason.restartRequired
        ? 300
        : Math.min(15000, 1000 * 2 ** Math.min(reconnectTries, 4))
      if ((restart || semCodigo) && reconnectTries < 20) {
        reconnectTries++
        log('reconectando em', wait, 'ms (tentativa', reconnectTries + ')')
        scheduleReconnect(wait)
      }
      return
    }
  })
  return s
}

// espera o socket ficar pronto p/ parear (QR). Pedir antes causa 401.
async function waitQrReady(ms = 25000) {
  const t0 = Date.now()
  while (!qrReady && status !== 'on' && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 200))
  }
  return qrReady || status === 'on'
}

function waitOpen(ms = 60000) {
  return new Promise((resolve, reject) => {
    if (status === 'on') return resolve()
    const t = setTimeout(() => reject(new Error('timeout conectando (60s)')), ms)
    const iv = setInterval(() => {
      if (status === 'on') { clearTimeout(t); clearInterval(iv); resolve() }
      if (!sock) { clearTimeout(t); clearInterval(iv); reject(new Error('conexão caiu')) }
    }, 500)
  })
}

// ---------- Conversão p/ padrão WhatsApp (512x512, <500KB) ----------
const OK_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.gif', '.webp', '.png', '.jpg', '.jpeg'])

async function probe(src) {
  const { stdout } = await pexec(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', src])
  const j = JSON.parse(stdout)
  const vs = (j.streams || []).find((s) => s.width) || {}
  let fps = 30
  if (vs.avg_frame_rate && vs.avg_frame_rate.includes('/')) {
    const [a, b] = vs.avg_frame_rate.split('/').map(Number)
    if (b) fps = a / b
  } else if (vs.r_frame_rate) {
    const [a, b] = String(vs.r_frame_rate).split('/').map(Number)
    if (b) fps = a / b
  }
  const dur = parseFloat(vs.duration || j.format?.duration || 0) || 0
  return { w: vs.width || 0, h: vs.height || 0, fps, dur }
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv'])
// crop = { x, y, s } em pixels do vídeo (já rotacionado): quadrado escolhido no painel
const vfFor = (fit, crop) => crop
  ? `crop=${crop.s}:${crop.s}:${crop.x}:${crop.y},scale=512:512:flags=lanczos`
  : fit === 'contain'
  ? 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0,format=yuva420p'
  : 'scale=512:512:force_original_aspect_ratio=increase:flags=lanczos,crop=512:512'

// Extrai frames já em 512x512. Retorna { files, dur, srcDur } (dur em segundos).
// ini/dur: trecho do vídeo (no máximo 10s); só esse trecho é decodificado.
async function extractFrames(src, ext, td, fit = 'cover', { ini = 0, dur: want = 10, crop = null } = {}) {
  const { default: sharp } = await import('sharp')
  const VF = vfFor(fit, crop)
  const list = async () => (await readdir(td)).filter((f) => f.endsWith('.png')).sort().map((f) => join(td, f))
  if (VIDEO_EXT.has(ext)) {
    const info = await probe(src).catch(() => ({ dur: 0 }))
    const start = info.dur > 0 ? Math.min(ini, Math.max(0, info.dur - 0.2)) : ini
    const left = info.dur > 0 ? info.dur - start : 10
    const dur = Math.max(0.2, Math.min(want, 10, left))
    const exFps = 30
    await pexec(FFMPEG, ['-y', '-v', 'error', '-ss', String(start), '-i', src, '-t', String(dur),
      '-vf', `fps=${exFps},${VF}`, join(td, 'f%04d.png')])
    return { files: await list(), dur, srcDur: info.dur || 0, start }
  }
  try {
    await pexec(FFMPEG, ['-y', '-v', 'error', '-i', src, '-vf', VF, join(td, 'f%04d.png')])
    const files = await list()
    if (!files.length) throw new Error('vazio')
    const info = await probe(src).catch(() => ({ dur: 0 }))
    return { files, dur: info.dur || 0 }
  } catch {
    // fallback: ffmpeg não decodifica alguns WebP/GIF animados
    const meta = await sharp(src, { animated: true }).metadata()
    const pages = Math.min(meta.pages || 1, 300)
    const files = []
    for (let p = 0; p < pages; p++) {
      const out = join(td, `f${String(p).padStart(4, '0')}.png`)
      const sh = sharp(src, { animated: false, page: p })
      if (crop) await sh.extract({ left: crop.x, top: crop.y, width: crop.s, height: crop.s }).resize(512, 512).png().toFile(out)
      else if (fit === 'contain') await sh.resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(out)
      else await sh.resize(512, 512, { fit: 'cover' }).png().toFile(out)
      files.push(out)
    }
    const delays = Array.isArray(meta.delay) ? meta.delay : []
    const dur = delays.length ? delays.reduce((a, b) => a + b, 0) / 1000 : 0
    return { files, dur }
  }
}

async function encodeSeq(seqDir, count, dest, fps, q) {
  await pexec(FFMPEG, ['-y', '-v', 'error',
    '-framerate', String(fps), '-i', join(seqDir, 'f%04d.png'),
    '-frames:v', String(count),
    '-c:v', 'libwebp_anim', '-loop', '0',
    '-quality', String(q), '-compression_level', '4', '-an', dest,
  ], { maxBuffer: 64 * 1024 * 1024 })
}

async function convertToSticker(src, dest, reqFps = 15, fit = 'cover', win = {}) {
  reqFps = Math.max(5, Math.min(24, parseInt(reqFps) || 15))
  fit = fit === 'contain' ? 'contain' : 'cover'
  const ext = ('.' + src.split('.').pop().toLowerCase()).slice(0, 5)
  const td = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'sticker-'))
  const { cp } = await import('node:fs/promises')
  const { mkdirSync } = await import('node:fs')
  try {
    const { files: all, dur: srcDur, srcDur: origDur, start } = await extractFrames(src, ext, td, fit, win)
    const total = all.length
    if (!total) throw new Error('não consegui ler o arquivo')
    const effDur = Math.min(srcDur > 0 ? srcDur : total / 10, 10) // trava 10s
    const cortado = (origDur ?? srcDur) > srcDur + 0.05
    const mid = Math.max(8, Math.min(reqFps - 1, Math.floor(reqFps * 0.6)))
    const ladder = [[reqFps, 65], [reqFps, 50], [mid, 50], [8, 40], [6, 30], [5, 20]]
    const seen = new Set()
    let lastErr = null
    for (const [fps, q] of ladder) {
      const key = fps + 'x' + q
      if (seen.has(key)) continue
      seen.add(key)
      const count = Math.max(1, Math.min(total, Math.round(effDur * fps)))
      const seq = join(td, `seq-${fps}-${q}`)
      mkdirSync(seq, { recursive: true })
      for (let i = 0; i < count; i++) {
        const si = Math.min(total - 1, Math.floor((i * total) / count))
        await cp(all[si], join(seq, `f${String(i).padStart(4, '0')}.png`))
      }
      const tmpOut = join(td, `out-${fps}-${q}.webp`)
      try {
        await encodeSeq(seq, count, tmpOut, fps, q)
      } catch (e) { lastErr = e; continue }
      const sz = (await stat(tmpOut)).size
      if (sz <= MAX_BYTES) {
        const d = webpDims(await readFile(tmpOut))
        if (!d || d.w !== 512 || d.h !== 512) throw new Error('falha na conversão (dims)')
        await cp(tmpOut, dest)
        return { kb: Math.round(sz / 1024), fps, fit: win.crop ? 'crop' : fit, frames: count, dur: count / fps, cortado, pedido: reqFps, start }
      }
    }
    throw new Error('não coube em 500KB — tente menos FPS ou trecho mais curto' + (lastErr ? '' : ''))
  } finally {
    await rm(td, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------- WebP: lê dimensões ----------
function webpDims(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  let o = 12
  while (o + 8 <= buf.length) {
    const four = buf.toString('ascii', o, o + 4)
    const size = buf.readUInt32LE(o + 4)
    const d = o + 8
    if (four === 'VP8X' && d + 10 <= buf.length) {
      const w = buf.readUIntLE(d + 4, 3) + 1
      const h = buf.readUIntLE(d + 7, 3) + 1
      return { w, h }
    }
    if (four === 'VP8 ' && d + 10 <= buf.length) {
      if (buf[d + 3] === 0x9d && buf[d + 4] === 0x01 && buf[d + 5] === 0x2a) {
        return { w: buf.readUInt16LE(d + 6) & 0x3fff, h: buf.readUInt16LE(d + 8) & 0x3fff }
      }
    }
    if (four === 'VP8L' && d + 5 <= buf.length && buf[d] === 0x2f) {
      const b = buf.readUInt32LE(d + 1)
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }
    }
    o = d + size + (size % 2)
  }
  return null
}

// ---------- Som: OGG/Opus sidecar ao lado do WebP ----------
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac'])
const MAX_AUDIO = 10
const sidecarOf = (webp) => webp.replace(/\.webp$/, '.ogg')

async function probeAudio(src) {
  const { stdout } = await pexec(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', src])
  const j = JSON.parse(stdout)
  const as = (j.streams || []).find((s) => s.codec_type === 'audio')
  const dur = parseFloat(as?.duration || j.format?.duration || 0) || 0
  return { has: !!as, codec: as?.codec_name || '', dur }
}

// Converte para OGG/Opus mono 48 kHz ~48 kbps, máximo 10s.
async function convertAudio(src, dest, { ini = 0, dur = MAX_AUDIO } = {}) {
  const before = await probeAudio(src).catch(() => ({ has: false, dur: 0 }))
  if (!before.has) throw new Error('o arquivo não tem faixa de áudio')
  // O AAC de vídeos MP4 (ex.: do WhatsApp) pode começar antes de 0; o OGG sai com start_time
  // negativo e o celular recusa tocar o som da figurinha. Passar por WAV (PCM sem timestamps)
  // garante que o Opus comece exatamente em 0, qualquer que seja a origem.
  const wav = dest + '.tmp.wav'
  try {
    const t = Math.max(0.2, Math.min(dur, MAX_AUDIO))
    await pexec(FFMPEG, ['-y', '-v', 'error', '-ss', String(Math.max(0, ini)), '-i', src, '-t', String(t), '-vn',
      '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 'wav', wav])
    await pexec(FFMPEG, ['-y', '-v', 'error', '-f', 'wav', '-i', wav,
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', dest])
  } finally {
    await rm(wav, { force: true }).catch(() => {})
  }
  const s = await stat(dest).catch(() => null)
  if (!s || !s.size) throw new Error('falha ao converter o áudio')
  const { stdout: st } = await pexec(FFPROBE, ['-v', 'error', '-show_entries', 'stream=start_pts', '-of', 'csv=p=0', dest])
  if (parseInt(st) < 0) throw new Error('o áudio convertido começou antes de 0')
  const after = await probeAudio(dest)
  if (after.codec !== 'opus' || !(after.dur > 0)) throw new Error('falha ao converter o áudio')
  return { dur: Math.round(after.dur * 10) / 10, kb: Math.max(1, Math.round(s.size / 1024)), cortado: before.dur > after.dur + 0.1 }
}

function slug(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `fig-${Date.now() % 100000}`
}

// ---------- HTTP utils ----------
function json(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length })
  res.end(b)
}
function body(res, data, type) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length })
  res.end(data)
}
async function readBody(req, max = 60 * 1024 * 1024) {
  const chunks = []
  let n = 0
  for await (const c of req) { n += c.length; if (n > max) throw new Error('muito grande'); chunks.push(c) }
  return Buffer.concat(chunks)
}
function parseMultipart(buf, boundary) {
  // trabalha direto no Buffer: vídeos grandes não viram uma string gigante na memória
  const fields = {}, files = {}
  const sep = Buffer.from('--' + boundary)
  const parts = []
  for (let p = buf.indexOf(sep); p >= 0;) {
    const n = buf.indexOf(sep, p + sep.length)
    if (n < 0) break
    parts.push(buf.subarray(p + sep.length, n))
    p = n
  }
  for (const part of parts) {
    const i = part.indexOf('\r\n\r\n')
    if (i < 0) continue
    const head = part.subarray(0, i).toString('utf-8')
    let content = part.subarray(i + 4)
    if (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10) content = content.subarray(0, -2)
    const m = head.match(/name="([^"]+)"/)
    if (!m || !content.length) continue
    const fm = head.match(/filename="([^"]*)"/)
    if (fm && fm[1]) files[m[1]] = { filename: fm[1], data: content }
    else fields[m[1]] = content.toString('utf-8')
  }
  return { fields, files }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'HEAD') { // HEAD comporta-se como GET, sem corpo
      req.method = 'GET'
      const _end = res.end.bind(res)
      res.end = (d) => _end(undefined)
    }
    const url = new URL(req.url, 'http://x')
    const seg = url.pathname.split('/').filter(Boolean)

    if (req.method === 'GET' && url.pathname === '/') return body(res, await readFile(join(DIR, 'painel.html')), 'text/html; charset=utf-8')

    if (req.method === 'GET' && seg[0] === 'assets' && seg.length === 2) {
      const f = join(DIR, 'assets', basename(decodeURIComponent(seg[1])))
      if (!/\.(woff2|css|png|jpg|webp)$/.test(f) || !existsSync(f)) { res.writeHead(404); return res.end() }
      const mime = f.endsWith('.woff2') ? 'font/woff2' : f.endsWith('.css') ? 'text/css'
        : f.endsWith('.png') ? 'image/png' : f.endsWith('.jpg') ? 'image/jpeg' : 'image/webp'
      const data = await readFile(f)
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'public, max-age=31536000, immutable' })
      return res.end(data)
    }

    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'status' && seg.length === 2) {
      // mantém sempre um socket vivo: é ele que permite parear e enviar
      if (!sock && (Date.now() - realCloseAt > 2000)) { try { await ensureSock() } catch {} }
      return json(res, { connected: status === 'on', me, numero: phoneOf(me), registered })
    }

    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'reconnect' && seg.length === 2) {
      try { await ensureSock() } catch {}
      return json(res, { ok: true })
    }

    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'logout' && seg.length === 2) {
      gen++ // invalida eventos do socket atual
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (sock) { try { await sock.logout() } catch {} try { sock.end(undefined) } catch {} sock = null }
      status = 'off'; me = null; registered = false; started = false; reconnectTries = 0
      await rm(AUTH, { recursive: true, force: true }).catch(() => {})
      return json(res, { ok: true })
    }

    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'pair' && seg.length === 2) {
      const { number } = JSON.parse((await readBody(req, 1024)).toString() || '{}')
      const num = String(number || '').replace(/\D/g, '')
      if (num.length < 10) return json(res, { ok: false, erro: 'número inválido' }, 400)
      if (pairBusy) return json(res, { ok: false, erro: 'código sendo gerado, aguarde' }, 409)
      pairBusy = true
      try {
        if (!sock) await ensureSock()
        const s = await ensureSock()
        if (registered) return json(res, { ok: true, already: true })
        log('pedido de código p/', num)
        // ESPERA o socket ficar pronto (QR). Pedir antes = 401 e sessão morta.
        if (!(await waitQrReady())) {
          log('socket não ficou pronto para parear')
          return json(res, { ok: false, erro: 'conectando ao WhatsApp, tente de novo em instantes' }, 503)
        }
        let code = null
        try { code = await s.requestPairingCode(num) } catch (e) { log('erro requestPairingCode:', e?.message || '') }
        if (!code) { log('falha ao gerar código') ; return json(res, { ok: false, erro: 'sem conexão, tente de novo' }, 502) }
        log('código gerado')
        return json(res, { ok: true, code })
      } finally {
        pairBusy = false
      }
    }

    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'stickers' && seg.length === 2) {
      const files = (await readdir(FIG)).filter((f) => f.endsWith('.webp')).sort()
      const out = []
      for (const f of files) {
        const s = await stat(join(FIG, f)).catch(() => null)
        if (!s || !s.size) continue // ignora restos de conversão falhada
        const a = await stat(join(FIG, sidecarOf(f))).catch(() => null)
        const som = !!(a && a.size)
        out.push({ name: f, kb: Math.round(s.size / 1024), som, ...(som ? { somKb: Math.max(1, Math.round(a.size / 1024)) } : {}) })
      }
      return json(res, { files: out })
    }

    if (req.method === 'GET' && seg[0] === 'fig' && seg.length === 2) {
      const f = join(FIG, basename(decodeURIComponent(seg[1])))
      if (!f.endsWith('.webp') || !existsSync(f)) { res.writeHead(404); return res.end() }
      return body(res, await readFile(f), 'image/webp')
    }

    if (req.method === 'GET' && seg[0] === 'audio' && seg.length === 2) {
      const n = basename(decodeURIComponent(seg[1]))
      const f = join(FIG, n)
      if (!/^[^\\/]+\.ogg$/.test(n) || !existsSync(f)) { res.writeHead(404); return res.end() }
      return body(res, await readFile(f), 'audio/ogg')
    }

    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'upload' && seg.length === 2) {
      const ct = req.headers['content-type'] || ''
      const m = ct.match(/boundary=([^;]+)/)
      if (!m) return json(res, { ok: false, erro: 'form inválido' }, 400)
      const { files, fields } = parseMultipart(await readBody(req, 400 * 1024 * 1024), m[1])
      const up = files.arquivo
      if (!up?.data.length) return json(res, { ok: false, erro: 'sem arquivo' }, 400)
      const ext = ('.' + (up.filename || '').split('.').pop().toLowerCase()).slice(0, 5)
      if (!OK_EXT.has(ext)) return json(res, { ok: false, erro: 'formato não aceito (mp4/gif/webp/png/jpg)' }, 400)
      const reqFps = Math.max(5, Math.min(24, parseInt(fields.fps) || 15))
      const fit = fields.fit === 'contain' ? 'contain' : 'cover'
      const som = ['video', 'separado'].includes(fields.som) ? fields.som : 'sem'
      const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d }
      const ini = num(fields.ini, 0), dur = Math.min(10, num(fields.dur, 10) || 10)
      const aIni = num(fields.aIni, 0), aDur = Math.min(MAX_AUDIO, num(fields.aDur, MAX_AUDIO) || MAX_AUDIO)
      let crop = null
      if (fields.crop) {
        const [x, y, s] = String(fields.crop).split(',').map((v) => Math.round(Number(v)))
        if ([x, y, s].every(Number.isFinite) && x >= 0 && y >= 0 && s >= 16) crop = { x, y, s: s - (s % 2) }
      }
      const aup = files.audio
      let aext = ''
      if (som === 'video' && !VIDEO_EXT.has(ext)) return json(res, { ok: false, erro: 'áudio do vídeo só funciona com vídeo (mp4/mov/webm/mkv)' }, 400)
      if (som === 'separado') {
        if (!aup?.data.length) return json(res, { ok: false, erro: 'escolha o arquivo de áudio' }, 400)
        aext = ('.' + (aup.filename || '').split('.').pop().toLowerCase()).slice(0, 6)
        if (!AUDIO_EXT.has(aext)) return json(res, { ok: false, erro: 'áudio não aceito (mp3/m4a/aac/wav/ogg/opus/flac)' }, 400)
      }
      const td = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'sticker-'))
      try {
        const src = join(td, 'in' + ext)
        await writeFile(src, up.data)
        let asrc = null
        if (som === 'video') {
          // checa antes de converter p/ não salvar figurinha sem o som pedido
          const pa = await probeAudio(src).catch(() => ({ has: false }))
          if (!pa.has) return json(res, { ok: false, erro: 'esse vídeo não tem áudio; escolha "Sem som" ou "Áudio separado"' }, 400)
          asrc = src
        } else if (som === 'separado') {
          asrc = join(td, 'som' + aext)
          await writeFile(asrc, aup.data)
        }
        const base = slug((fields.nome || up.filename || '').replace(/\.[a-z0-9]+$/i, ''))
        let name = base + '.webp', i = 1
        while (existsSync(join(FIG, name)) || existsSync(join(FIG, sidecarOf(name)))) name = `${base}-${++i}.webp`
        const dest = join(FIG, name)
        const r = await convertToSticker(src, dest, reqFps, fit, { ini, dur, crop })
        if (!asrc) return json(res, { ok: true, arquivo: name, ...r })
        const ogg = sidecarOf(name)
        let a
        try {
          // áudio do vídeo acompanha o trecho da imagem; áudio separado tem trecho próprio
          a = await convertAudio(asrc, join(FIG, ogg), som === 'video' ? { ini: r.start ?? ini, dur: r.dur } : { ini: aIni, dur: aDur })
        } catch (e) {
          await rm(dest, { force: true }).catch(() => {})
          await rm(join(FIG, ogg), { force: true }).catch(() => {})
          return json(res, { ok: false, erro: 'áudio: ' + (e.message || 'falha na conversão') }, 400)
        }
        return json(res, { ok: true, arquivo: name, ...r, som: { origem: som, ...a }, audioUrl: '/audio/' + encodeURIComponent(ogg) })
      } finally {
        await rm(td, { recursive: true, force: true }).catch(() => {})
      }
    }

    if (req.method === 'DELETE' && seg[0] === 'api' && seg[1] === 'stickers' && seg.length === 3) {
      const f = join(FIG, basename(decodeURIComponent(seg[2])))
      if (!f.endsWith('.webp') || !existsSync(f)) { res.writeHead(404); return res.end() }
      const { unlink } = await import('node:fs/promises')
      await unlink(f)
      await rm(sidecarOf(f), { force: true }).catch(() => {})
      return json(res, { ok: true })
    }

    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'send' && seg.length === 2) {
      const { file, number } = JSON.parse((await readBody(req, 4096)).toString() || '{}')
      const num = String(number || '').replace(/\D/g, '')
      if (!file || num.length < 10) return json(res, { ok: false, erro: 'arquivo/número inválido' }, 400)
      const p = join(FIG, basename(file))
      if (!p.endsWith('.webp') || !existsSync(p)) return json(res, { ok: false, erro: 'figurinha não encontrada' }, 404)
      await ensureSock()
      await waitOpen()
      const jid = `${num}@s.whatsapp.net`
      const ogg = sidecarOf(p)
      if (existsSync(ogg)) {
        const { dur } = await probeAudio(ogg)
        const full = await buildSoundStickerMessage({
          jid, userJid: sock.user.id, stickerBuf: await readFile(p), audioBuf: await readFile(ogg),
          seconds: dur, upload: sock.waUploadToServer,
        })
        await sock.relayMessage(jid, full.message, { messageId: full.key.id })
        return json(res, { ok: true, som: true })
      }
      await sock.sendMessage(jid, { sticker: await readFile(p) })
      return json(res, { ok: true, som: false })
    }

    res.writeHead(404); res.end()
  } catch (e) {
    json(res, { ok: false, erro: e.message || 'erro' }, 500)
  }
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Porta ${PORT} em uso — já tem um painel rodando? Acesse http://localhost:${PORT} ou derrube o outro (taskkill /F /IM node.exe).`)
    process.exit(1)
  }
  throw e
})

await migrate()
await rotateLog()
log('servidor iniciado')
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Painel: http://localhost:${PORT} (só neste PC)`)
})
