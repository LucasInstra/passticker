# Passticker

**English** | [Português](README.pt-BR.md)

Local WhatsApp animated sticker sender with sound, straight from your PC. Personal use, one session at a time.

The panel converts any media to WhatsApp's sticker format (512x512, animated WebP, up to 500 KB, 10 s) and sends it as a real sticker. Sound travels inside the `StickerMessage` itself, in field 26 (`audioMessage`).

## Requirements

- Node.js 20 or newer
- Windows for the double-click scripts (the app runs on any OS)
- `ffmpeg` and `ffprobe` ship as dependencies (`ffmpeg-static`, `ffprobe-static`)

## Install

```bash
npm install
npm start
```

Open `http://localhost:8000`.

Without a terminal, on Windows:

- `scripts/iniciar.bat`: installs on first run, opens the panel and starts the server
- `scripts/parar.bat`: stops the process listening on port 8000
- `scripts/adicionar-a-inicializacao.bat`: starts with Windows, without a window

## Pairing

1. In the panel, enter your number with country and area codes, digits only.
2. Click Generate code.
3. On your phone: WhatsApp > Linked devices > Link a device > Link with phone number instead, then enter the code.
4. The session is saved in `auth/` and reconnects automatically next time.

The pairing code is only requested after the socket is ready. Requesting it earlier makes WhatsApp close the connection with 401.

## Sound stickers

In the Create section, the **Sound** field has three options:

- **No sound**: default behavior.
- **Video audio**: uses the audio from the video itself; image and sound cover the first 10 s.
- **Separate audio**: attaches mp3, m4a, aac, wav, ogg, opus or flac to any sticker.

Audio is converted to OGG/Opus mono, 48 kHz, around 48 kbps, capped at 10 s. It is saved as a sidecar `figurinhas/<name>.ogg`, so sending the sticker again from the gallery keeps the sound. Deleting the sticker removes both files.

Baileys' proto does not know field 26, so `sound-sticker.js` injects `audioMessage` into the encoder at runtime, without touching `node_modules`. Recipients on a WhatsApp version without the feature see a normal sticker, without sound.

## Command line

```bash
node send.js figurinhas/file.webp 5511999999999
node send.js figurinhas/file.webp 5511999999999 --code
```

`--code` forces pairing with a code instead of using the saved session.

## Project layout

```
server.js          HTTP, WhatsApp session, upload, conversion and sending
sound-sticker.js   proto patch and sound sticker message builder
send.js            command-line sender
painel.html        local interface
assets/            Faustina and Geist fonts (OFL)
scripts/           Windows shortcuts
auth/              WhatsApp session (not versioned)
figurinhas/        WebP output and OGG sidecars (not versioned)
atividade.log      diagnostics (not versioned)
```

## Security and limits

- `auth/` holds the session credentials. Never version, share or copy that folder.
- WhatsApp logs out inactive linked devices. If the panel shows 401, generate a new code.
- Personal use only. This project is not affiliated with WhatsApp or Meta.
- A 10 s audio may end up around 10.006 s in the container. If a client rejects it, use 9.98 in `MAX_AUDIO`.
