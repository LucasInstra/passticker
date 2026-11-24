# Passticker

Envio local de figurinhas animadas para o WhatsApp, com som, direto do PC. Uso pessoal, uma sessão por vez.

O painel converte qualquer mídia para o padrão do WhatsApp (512x512, WebP animado, até 500 KB, 10 s) e envia como figurinha de verdade. O som viaja dentro da própria `StickerMessage`, no campo 26 (`audioMessage`).

## Requisitos

- Node.js 20 ou superior
- Windows para os atalhos de duplo clique (o app roda em qualquer sistema)
- `ffmpeg` e `ffprobe` já vêm como dependências (`ffmpeg-static`, `ffprobe-static`)

## Instalação

```bash
npm install
npm start
```

Abra `http://localhost:8000`.

Sem terminal, no Windows:

- `scripts/iniciar.bat`: instala na primeira vez, abre o painel e sobe o servidor
- `scripts/parar.bat`: encerra o processo da porta 8000
- `scripts/adicionar-a-inicializacao.bat`: inicia junto com o Windows, sem janela

## Pareamento

1. No painel, informe o número com DDI + DDD, só dígitos.
2. Clique em Gerar código.
3. No celular: WhatsApp > Aparelhos conectados > Conectar aparelho > Conectar com número de telefone > digite o código.
4. A sessão fica em `auth/` e reconecta sozinha nas próximas vezes.

O código só é pedido depois que o socket está pronto. Pedir antes faz o WhatsApp encerrar a conexão com 401.

## Figurinha com som

Na seção Criar, o campo **Som** tem três opções:

- **Sem som**: comportamento padrão.
- **Áudio do vídeo**: usa o áudio do próprio vídeo; imagem e som ficam nos primeiros 10 s.
- **Áudio separado**: anexa mp3, m4a, aac, wav, ogg, opus ou flac a qualquer figurinha.

O áudio é convertido para OGG/Opus mono, 48 kHz, cerca de 48 kbps, com no máximo 10 s. Ele é salvo como sidecar `figurinhas/<nome>.ogg`, então reenviar pela galeria mantém o som. Excluir a figurinha apaga os dois arquivos.

O proto do Baileys não conhece o campo 26, então `sound-sticker.js` injeta o `audioMessage` no encoder em runtime, sem alterar `node_modules`. Quem estiver em uma versão do WhatsApp sem o recurso vê a figurinha normal, sem som.

## Linha de comando

```bash
node send.js figurinhas/arquivo.webp 5511999999999
node send.js figurinhas/arquivo.webp 5511999999999 --code
```

`--code` força o pareamento por código em vez de usar a sessão salva.

## Estrutura

```
server.js          HTTP, sessão do WhatsApp, upload, conversão e envio
sound-sticker.js   patch do proto e montagem da figurinha com som
send.js            envio por linha de comando
painel.html        interface local
assets/            fontes Faustina e Geist (OFL)
scripts/           atalhos do Windows
auth/              sessão do WhatsApp (não versionada)
figurinhas/        saída em WebP e sidecars OGG (não versionada)
atividade.log      diagnóstico (não versionado)
```

## Segurança e limites

- `auth/` contém as credenciais da sessão. Nunca versione, compartilhe ou copie essa pasta.
- O WhatsApp encerra dispositivos inativos. Se o painel mostrar 401, gere um código novo.
- Uso pessoal. O projeto não é afiliado ao WhatsApp ou à Meta.
- Áudio de 10 s pode sair com cerca de 10,006 s no container. Se algum cliente recusar, use 9,98 em `MAX_AUDIO`.
