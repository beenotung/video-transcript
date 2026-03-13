import { spawnAndWait } from '@beenotung/tslib/child_process'
import { mkdirSync, readdirSync } from 'fs'

let downloadsDir = 'downloads'

mkdirSync(downloadsDir, { recursive: true })

export async function downloadVideo(url: string) {
  var { stdout, stderr, code } = await spawnAndWait({
    cmd: 'yt-dlp',
    args: ['-F', url],
  })
  let lines = stdout.split('\n')
  let formats = []
  for (let line of lines) {
    // e.g. 'ID EXT RESOLUTION FPS CH |  FILESIZE   TBR PROTO | VCODEC  VBR ACODEC ABR'
    // e.g. '0  mp4 720x1280    30  2 |  15.39MiB 1022k http  | h264   960k aac    56k'
    let parts = line.split(' ').filter(part => part.length > 0)

    let id = +parts[0]
    if (!Number.isInteger(id)) continue

    let format = parts[1]
    if (!isVideoFormat(format)) continue

    let resolution = parseFormat(parts[2])
    if (!resolution.width || !resolution.height) continue

    let fps = +parts[3]
    if (!Number.isInteger(fps)) continue

    let ch = +parts[4]
    if (!Number.isInteger(ch)) continue

    let fileSize = parseFileSize(parts[6])
    if (!Number.isFinite(fileSize)) continue

    formats.push({
      id,
      format,
      resolution,
      fps,
      ch,
      fileSize,
    })
  }
  formats.sort((a, b) => a.fileSize - b.fileSize)
  let format = formats[0]
  if (!format) {
    throw new Error('No format found')
  }
  var { code, stdout, stderr } = await spawnAndWait({
    cmd: 'yt-dlp',
    args: ['-f', format.id.toString(), url],
    options: { cwd: downloadsDir },
  })
  console.log({ code, stdout, stderr })
}

function isVideoFormat(format: string) {
  let formats = ['mp4', 'webm']
  return formats.includes(format)
}

function parseFormat(text: string) {
  // e.g. '720x1280'
  let parts = text.split('x')
  let width = +parts[0]
  let height = +parts[1]
  return { width, height }
}

function parseFileSize(text: string) {
  let value = parseFloat(text)
  let unit = text.slice(value.toString().length)
  return value * parseUnit(unit)
}

function parseUnit(text: string) {
  switch (text) {
    case 'B':
      return 1
    case 'KiB':
      return 1024
    case 'MiB':
      return 1024 ** 2
    case 'GiB':
      return 1024 ** 3
    default:
      throw new Error(`Unknown unit: ${text}`)
  }
}

async function downloadXHSVideo(url: string) {
  let id = new URL(url).pathname.split('/').pop()
  let filename = readdirSync(downloadsDir).find(name =>
    name.includes(`[${id}]`),
  )
  if (!filename) {
    await downloadVideo(url)
  }
  return { id, filename, url }
}

async function main() {
  let url =
    'https://www.xiaohongshu.com/discovery/item/69a45992000000001a032111?xsec_token=CBQNYbf2u0p7fnqO5AxjG02uCTmVftf1gvK-Kj1_22B38%3D'
  var { id, filename } = await downloadXHSVideo(url)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
