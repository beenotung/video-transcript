import { startTimer } from '@beenotung/tslib/timer'
import { spawnAndWait } from '@beenotung/tslib/child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { basename, join } from 'path'

let downloadsDir = 'downloads'
let snapshotDir = 'snapshots'
let croppedDir = 'cropped'
let resultDir = 'result'

mkdirSync(downloadsDir, { recursive: true })
mkdirSync(snapshotDir, { recursive: true })
mkdirSync(croppedDir, { recursive: true })
mkdirSync(resultDir, { recursive: true })

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
    filename = readdirSync(downloadsDir).find(name => name.includes(`[${id}]`))
  }
  if (!filename) throw new Error(`Video not found: ${url}`)
  let videoFile = join(downloadsDir, filename)
  return { id, filename, url, videoFile }
}

async function getVideoDuration(file: string) {
  let { stdout, stderr, code } = await spawnAndWait({
    cmd: 'ffprobe',
    args: [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ],
  })
  if (code !== 0) {
    console.error({ stdout, stderr, code })
    throw new Error('Failed to get video duration')
  }
  return parseFloat(stdout)
}

async function takeSnapshot(args: {
  inFile: string
  outFile: string
  time: number
}) {
  let { inFile, outFile, time } = args
  let { stdout, stderr, code } = await spawnAndWait({
    cmd: 'ffmpeg',
    args: [
      '-y',
      '-i',
      inFile,
      '-v',
      'error',
      '-ss',
      time.toString(),
      '-frames:v',
      '1',
      outFile,
    ],
  })
  if (code !== 0) {
    console.error({ stdout, stderr, code })
    throw new Error('Failed to take snapshot')
  }
}

async function getImageResolution(file: string) {
  var { stdout, stderr, code } = await spawnAndWait({
    cmd: 'identify',
    args: ['-format', '%wx%h', file],
  })
  let parts = stdout.split('x')
  let width = +parts[0]
  let height = +parts[1]
  return { width, height }
}

async function cropImage(args: {
  inFile: string
  outFile: string
  width: number
  height: number
  top: number
  left: number
}) {
  let { inFile, outFile, width, height, top, left } = args
  var { stdout, stderr, code } = await spawnAndWait({
    cmd: 'ffmpeg',
    args: [
      '-y',
      '-i',
      inFile,
      '-v',
      'error',
      '-filter:v',
      `crop=${width}:${height}:${left}:${top}`,
      outFile,
    ],
  })
  if (code !== 0) {
    console.error({ stdout, stderr, code })
    throw new Error('Failed to crop image')
  }
}

async function main() {
  let url =
    'https://www.xiaohongshu.com/discovery/item/69a45992000000001a032111?xsec_token=CBQNYbf2u0p7fnqO5AxjG02uCTmVftf1gvK-Kj1_22B38%3D'

  var { filename, videoFile } = await downloadXHSVideo(url)
  console.log({ videoFile })

  let duration = await getVideoDuration(videoFile)
  console.log({ duration })
  if (!duration) throw new Error('Invalid duration')

  let time = duration / 2
  let snapshotFile = join(snapshotDir, `${filename}-${time}.jpg`)
  let { width, height } = await getImageResolution(snapshotFile)

  // TODO dynamically determine the step, or deduplicate the result based on OCR result
  let step = 1.5
  let timer = startTimer('takeSnapshot')
  timer.setEstimateProgress(duration)
  let croppedFiles = []
  for (let time = 0; time < duration; time += step) {
    let snapshotFile = join(snapshotDir, `${filename}-${time}.jpg`)
    if (!existsSync(snapshotFile)) {
      await takeSnapshot({ inFile: videoFile, outFile: snapshotFile, time })
    }

    let croppedFile = join(croppedDir, `${filename}-${time}-cropped.jpg`)
    if (!existsSync(croppedFile)) {
      await cropImage({
        inFile: snapshotFile,
        outFile: croppedFile,
        width: width,
        height: 1018 - 978,
        top: 978,
        left: 0,
      })
    }
    croppedFiles.push(croppedFile)

    timer.tick(step)
  }
  timer.end()

  let html = readFileSync('template/result.html', 'utf-8')
  html = html.replace(
    '<title></title>',
    `<title>Transcript of ${filename}</title>`,
  )
  html = html.replace(
    '<body></body>',
    `<body>${croppedFiles
      .map(file => {
        let url =
          '/' +
          file
            .split('/')
            .map(s => encodeURIComponent(s))
            .join('/')
        return `<img src="${url}" />`
      })
      .join('\n')}</body>`,
  )
  let resultFile = join(resultDir, `${filename}.html`)
  writeFileSync(resultFile, html)
  console.log({ resultFile })
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
