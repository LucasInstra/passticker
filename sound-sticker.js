// Figurinha com som: o WhatsApp atual envia a figurinha embrulhada no campo 134 da Message
// (134 { 1: Message { 26: StickerMessage { ..., 24, 25, 26: AudioMessage } } }).
// O proto do Baileys não conhece o campo 134 nem os campos 24-26 da StickerMessage,
// então eles são injetados aqui no encoder, em runtime, sem alterar node_modules.
import { proto, prepareWAMessageMedia, generateWAMessageFromContent } from '@whiskeysockets/baileys'

const TAG_AUDIO = 26 * 8 + 2 // field 26, wire type 2 (length-delimited) = 210
export const SOUND_MIME = 'audio/ogg; codecs=opus'
let patched = false

// Monta a mensagem de figurinha com som (sobe os dois arquivos e injeta o áudio no campo 26).
// `upload` é o sock.waUploadToServer; `seconds` explícito evita depender de ffprobe no Baileys.
export async function buildSoundStickerMessage({ jid, userJid, stickerBuf, audioBuf, seconds, upload }) {
  patchSoundStickerProto()
  const stickerMedia = await prepareWAMessageMedia({ sticker: stickerBuf }, { upload })
  const audioMedia = await prepareWAMessageMedia(
    { audio: audioBuf, mimetype: SOUND_MIME, seconds: Math.max(1, Math.round(seconds || 1)), ptt: false },
    { upload }
  )
  // o cliente oficial não manda ptt no áudio da figurinha
  delete audioMedia.audioMessage.ptt
  stickerMedia.stickerMessage.audioMessage = audioMedia.audioMessage
  // WebP animado tem chunk ANIM logo no cabeçalho; o cliente oficial marca isAnimated
  if (stickerBuf.subarray(0, 64).includes('ANIM')) stickerMedia.stickerMessage.isAnimated = true
  // demais campos que o cliente oficial preenche na figurinha com som
  const sm = stickerMedia.stickerMessage
  sm.firstFrameLength = webpLengthBeforeExif(stickerBuf) // tamanho do WebP antes do chunk EXIF
  sm.contextInfo = { ...(sm.contextInfo || {}), disappearingMode: { initiator: 0 } }
  sm.stickerSentTs = Date.now()
  sm.isLottie = false
  const msg = generateWAMessageFromContent(jid, stickerMedia, { userJid })

  // O cliente oficial envia a figurinha com som embrulhada no campo 134 da Message
  // (134 { 1: Message { 26: StickerMessage { ..., 26: AudioMessage } } }).
  // `outer` só tem o envelope como campo próprio (é o que vai no fio); a stickerMessage fica
  // no protótipo para o Baileys continuar marcando o envio como mediatype=sticker.
  const inner = msg.message
  const view = Object.create(proto.Message.prototype)
  view.stickerMessage = inner.stickerMessage
  const outer = Object.create(view)
  outer[WRAP] = inner
  msg.message = outer

  return msg
}

function webpLengthBeforeExif(buf) {
  let p = 12
  while (p + 8 <= buf.length) {
    if (buf.toString('latin1', p, p + 4) === 'EXIF') return p
    const n = buf.readUInt32LE(p + 4)
    p += 8 + n + (n & 1)
  }
  return buf.length
}

const WRAP = Symbol('stickerWithSound')
const TAG_WRAP = 134 * 8 + 2 // field 134, wire type 2 = 1074

export function patchSoundStickerProto() {
  if (patched) return
  patched = true

  const Sticker = proto.Message.StickerMessage
  const Audio = proto.Message.AudioMessage
  if (!Audio) throw new Error('Message.AudioMessage não existe no proto do Baileys')

  // envelope 134: mesmo formato de FutureProofMessage (campo 1 = Message)
  const Message = proto.Message
  const FutureProof = proto.Message.FutureProofMessage
  const msgEncodeOriginal = Message.encode
  Message.encode = function encode(m, w) {
    w = msgEncodeOriginal.call(this, m, w)
    if (m && m[WRAP]) {
      w.uint32(TAG_WRAP).fork()
      FutureProof.encode({ message: m[WRAP] }, w)
      w.ldelim()
    }
    return w
  }

  const encodeOriginal = Sticker.encode
  Sticker.encode = function encode(m, w) {
    // o encoder original não conhece audioMessage, então escreve tudo e depois anexa o campo 26
    w = encodeOriginal(m, w)
    if (m && m.audioMessage != null) {
      // campos 24 (varint 0) e 25 (bytes vazios): desconhecidos do proto, mas o cliente oficial manda
      w.uint32(24 * 8 + 0).uint32(0)
      w.uint32(25 * 8 + 2).uint32(0)
      w.uint32(TAG_AUDIO).fork()
      Audio.encode(m.audioMessage, w)
      w.ldelim()
    }
    return w
  }
}

// Varre os campos de um protobuf cru (sem schema) e devolve o conteúdo de um field id.
export function findField(bytes, fieldId) {
  let pos = 0
  const varint = () => {
    let shift = 0
    let value = 0
    while (true) {
      if (pos >= bytes.length) throw new Error('varint truncado')
      const b = bytes[pos++]
      value |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return value
      shift += 7
      if (shift > 63) throw new Error('varint inválido')
    }
  }
  while (pos < bytes.length) {
    const tag = varint()
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) varint()
    else if (wire === 1) pos += 8
    else if (wire === 2) {
      const len = varint()
      const chunk = bytes.subarray(pos, pos + len)
      if (field === fieldId) return chunk
      pos += len
    } else if (wire === 5) pos += 4
    else throw new Error('wire type inesperado: ' + wire)
  }
  return null
}
