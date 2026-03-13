import { startTimer } from '@beenotung/tslib/timer'
import { spawnAndWait } from '@beenotung/tslib/child_process'
import { createCanvas, ImageData, loadImage } from 'canvas'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { readdir, writeFile } from 'fs/promises'
import { basename, join } from 'path'

let multiLinePaddingRatio = 0.75
let singleLinePaddingRatio = 0.25

let paddingRatio = multiLinePaddingRatio

let step = 0.5

let downloadsDir = 'res/downloads'
let snapshotDir = 'res/snapshots'
let croppedDir = 'res/cropped'
let resultDir = 'res/result'
let averageDir = 'res/average'
let statsDir = 'res/stats'

mkdirSync(downloadsDir, { recursive: true })
mkdirSync(snapshotDir, { recursive: true })
mkdirSync(croppedDir, { recursive: true })
mkdirSync(resultDir, { recursive: true })
mkdirSync(averageDir, { recursive: true })
mkdirSync(statsDir, { recursive: true })

export async function downloadVideo(url: string) {
  var { stdout, stderr, code } = await spawnAndWait({
    cmd: 'yt-dlp',
    args: ['-F', url],
  })
  if (code !== 0) {
    console.error({ stdout, stderr, code })
    throw new Error('Failed to get video formats')
  }
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

    let fileSizeText = parts[6].trim()
    if (fileSizeText === '≈') {
      fileSizeText = parts[7].trim()
    }
    let fileSize = fileSizeText.length == 0 ? 0 : parseFileSize(fileSizeText)
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
  if (code !== 0) {
    console.error({ stdout, stderr, code })
    throw new Error('Failed to download video')
  }
  return { format }
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

function inferFilenamePattern(args: { url: string }) {
  let url = new URL(args.url)
  if (url.hostname == 'www.xiaohongshu.com') {
    // e.g. 'https://www.xiaohongshu.com/discovery/item/xxxxxxx?xsec_token=xxxxx'
    let id = url.pathname
      .split('/')
      .pop()!
      .replace(/^[0-9]+_/, '')
    return `[${id}]`
  }
  if (url.hostname.includes('youtube')) {
    // e.g. 'https://www.youtube.com/watch?v=xxxxxx'
    let id = url.searchParams.get('v')!
    return `[${id}]`
  }
  if (url.hostname == 'youtu.be') {
    // e.g. 'https://youtu.be/xxxxx?si=xxxx'
    let id = url.pathname.split('/').pop()!
    return `[${id}]`
  }
  throw new Error(`Unsupported URL: ${url}`)
}

// e.g. remove playlist id in youtube url
function cleanUrl(args: { url: string }) {
  let url = new URL(args.url)
  if (url.hostname.includes('youtube')) {
    url.searchParams.delete('list')
    url.searchParams.delete('index')
  }
  return url.href
}

async function getVideoFile(url: string) {
  url = cleanUrl({ url })
  let pattern = inferFilenamePattern({ url })
  let filenames = await readdir(downloadsDir)
  let filename = filenames.find(name => name.includes(pattern))
  if (!filename) {
    await downloadVideo(url)
    filenames = await readdir(downloadsDir)
    filename = filenames.find(name => name.includes(pattern))
  }
  if (!filename) throw new Error(`Video not found: ${url}`)
  let videoFile = join(downloadsDir, filename)
  return { pattern, filename, url, videoFile }
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

function findAllCaptionRegions(args: { delta: number[] }) {
  let delta = args.delta.slice()

  let regions = []

  for (;;) {
    let maxDelta = Math.max(...delta)
    if (!maxDelta) break
    let startIndex = delta.indexOf(maxDelta)
    let rest = delta.slice(startIndex)
    let minDelta = Math.min(...rest)
    let endIndex = startIndex + rest.indexOf(minDelta)
    let height = endIndex - startIndex + 1
    let padding = Math.floor(height * paddingRatio)
    startIndex = Math.max(0, startIndex - padding)
    endIndex = Math.min(delta.length - 1, endIndex + padding)
    height = endIndex - startIndex + 1
    let center = Math.floor(startIndex + height / 2)
    regions.push({
      startIndex,
      endIndex,
      height,
      center,
    })
    for (let i = startIndex; i <= endIndex; i++) {
      delta[i] = 0
    }
  }

  return regions
}

function tryFilter<T>(xs: T[], predicate: (x: T) => boolean): T[] {
  let filtered = xs.filter(predicate)
  if (filtered.length > 0) {
    return filtered
  }
  return xs
}

function calculateCaptureRegion(args: {
  // y -> x -> [r, g, b, a]
  data: number[] | ImageData['data']
  width: number
  height: number
}) {
  let { width, height, data } = args

  let brightness = new Array(height).fill(0)
  let offset = 0
  for (let y = 0; y < height; y++) {
    let sum = 0
    for (let x = 0; x < width; x++) {
      let r = data[offset++]
      let g = data[offset++]
      let b = data[offset++]
      let a = data[offset++] / 255
      let brightness = (r + g + b) / 3
      sum += brightness * a
    }
    brightness[y] = sum / width
  }

  let delta = new Array(brightness.length).fill(0)
  for (let i = 1; i < brightness.length; i++) {
    delta[i] = brightness[i] - brightness[i - 1]
  }
  let captionRegions = findAllCaptionRegions({ delta })
  console.log({ allCaptionRegions: captionRegions })

  // caption should be in the lower part of the screen
  captionRegions = tryFilter(
    captionRegions,
    region => region.center / height > 0.5,
  )

  // caption should have enough height
  captionRegions = tryFilter(captionRegions, region => region.height >= 10)

  // caption should not be too tall
  captionRegions = tryFilter(
    captionRegions,
    region => region.height <= height * 0.3,
  )

  // choose the one closest to the center of the screen
  captionRegions.sort((a, b) => a.center - b.center)
  console.log({ preferredCaptionRegions: captionRegions })
  let captionRegion = captionRegions[0]
  if (!captionRegion) throw new Error('No caption region found')

  return {
    width,
    height: captionRegion.height,
    top: captionRegion.startIndex,
    left: 0,
    brightness,
    delta,
  }
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

let htmlTemplate = readFileSync('template/result.html', 'utf-8')

function generateResultHTML(args: {
  filename: string
  croppedFiles: string[]
}) {
  let { filename, croppedFiles } = args
  let html = htmlTemplate
    .replace('<title></title>', `<title>Transcript of ${filename}</title>`)
    .replace(
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
  return html
}

async function main() {
  let url =
    'https://www.xiaohongshu.com/discovery/item/69a45992000000001a032111?xsec_token=CBQNYbf2u0p7fnqO5AxjG02uCTmVftf1gvK-Kj1_22B38%3D'

  var { filename, videoFile } = await getVideoFile(url)
  console.log({ videoFile })

  let duration = await getVideoDuration(videoFile)
  console.log({ duration })
  if (!duration) throw new Error('Invalid duration')

  let timer = startTimer('takeSnapshot')
  let snapshotFiles = []
  let existingSnapshotFiles = await readdir(snapshotDir)
  existingSnapshotFiles = existingSnapshotFiles.map(file =>
    join(snapshotDir, file),
  )
  let newSnapshots = []
  for (let time = 0; time < duration; time += step) {
    let snapshotFile = join(
      snapshotDir,
      `${filename}-${Number.isInteger(time) ? time.toFixed(1) : time}.jpg`,
    )
    if (!existsSync(snapshotFile)) {
      newSnapshots.push({ time, snapshotFile })
    }
    snapshotFiles.push(snapshotFile)
  }
  timer.setEstimateProgress(newSnapshots.length)
  for (let newSnapshot of newSnapshots) {
    await takeSnapshot({
      inFile: videoFile,
      outFile: newSnapshot.snapshotFile,
      time: newSnapshot.time,
    })
    timer.tick()
  }
  let { width, height } = await getImageResolution(snapshotFiles[0])

  let averageFile = join(averageDir, `${filename}-average-${step}.jpg`)
  if (!existsSync(averageFile)) {
    let canvas = createCanvas(width, height)
    let context = canvas.getContext('2d')
    // y -> x -> [r, g, b, a]
    let pixels = new Array(width * height * 4).fill(0)
    let n = snapshotFiles.length
    timer.next('detect caption region')
    timer.setEstimateProgress(snapshotFiles.length)
    for (let file of snapshotFiles) {
      let image = await loadImage(file)
      context.drawImage(image, 0, 0)
      let data = context.getImageData(0, 0, image.width, image.height).data
      for (let i = 0; i < data.length; i++) {
        pixels[i] += data[i]
      }
      timer.tick()
    }
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] /= n
    }
    let imageData = new ImageData(width, height)
    for (let i = 0; i < pixels.length; i++) {
      let value = Math.round(pixels[i])
      if (value < 0) value = 0
      if (value > 255) value = 255
      imageData.data[i] = value
    }
    context.putImageData(imageData, 0, 0)
    await writeFile(averageFile, canvas.toBuffer('image/jpeg'))
  }
  console.log({ averageFile })

  let imageData = await loadImage(averageFile)
  let canvas = createCanvas(imageData.width, imageData.height)
  let context = canvas.getContext('2d')
  context.drawImage(imageData, 0, 0)
  let data = context.getImageData(0, 0, imageData.width, imageData.height).data
  let cropRegion = calculateCaptureRegion({
    width,
    height,
    data,
  })
  console.log({
    cropRegion: {
      width: cropRegion.width,
      height: cropRegion.height,
      top: cropRegion.top,
      left: cropRegion.left,
    },
  })

  let statsFile = join(statsDir, `${filename}-stats.csv`)
  if (!existsSync(statsFile)) {
    await writeFile(
      statsFile,
      'y,brightness,delta\n' +
        cropRegion.brightness
          .map((brightness, y) => `${y},${brightness},${cropRegion.delta[y]}`)
          .join('\n'),
    )
  }
  console.log({ statsFile })

  timer.next('crop caption')
  timer.setEstimateProgress(snapshotFiles.length)
  let croppedFiles = []
  let newCrops = []
  for (let snapshotFile of snapshotFiles) {
    let croppedFile = join(
      croppedDir,
      [
        basename(snapshotFile),
        'cropped',
        cropRegion.width + 'x' + cropRegion.height,
        cropRegion.top + '_' + cropRegion.left,
      ].join('-') + '.jpg',
    )
    if (!existsSync(croppedFile)) {
      newCrops.push({ snapshotFile, croppedFile })
    }
    croppedFiles.push(croppedFile)
  }
  timer.setEstimateProgress(newCrops.length)
  for (let newCrop of newCrops) {
    await cropImage({
      inFile: newCrop.snapshotFile,
      outFile: newCrop.croppedFile,
      width: cropRegion.width,
      height: cropRegion.height,
      top: cropRegion.top,
      left: cropRegion.left,
    })
    timer.tick()
  }
  timer.end()

  let resultFile = join(resultDir, `${filename}.html`)
  let html = generateResultHTML({ filename, croppedFiles })
  await writeFile(resultFile, html)
  console.log({ resultFile })
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
