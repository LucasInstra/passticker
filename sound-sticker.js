// Figurinha com som: o WhatsApp guarda o áudio dentro da própria StickerMessage,
// no campo 26 (`audioMessage`, do tipo Message.AudioMessage).
// O proto do Baileys ainda não conhece esse campo, então ele é injetado aqui
// no encoder, em runtime, sem alterar node_modules.
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
  stickerMedia.stickerMessage.audioMessage = audioMedia.audioMessage
  return generateWAMessageFromContent(jid, stickerMedia, { userJid })
}

export function patchSoundStickerProto() {
  if (patched) return
  patched = true

  const Sticker = proto.Message.StickerMessage
  const Audio = proto.Message.AudioMessage
  if (!Audio) throw new Error('Message.AudioMessage não existe no proto do Baileys')

  const encodeOriginal = Sticker.encode
  Sticker.encode = function encode(m, w) {
    // o encoder original não conhece audioMessage, então escreve tudo e depois anexa o campo 26
    w = encodeOriginal(m, w)
    if (m && m.audioMessage != null) {
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
