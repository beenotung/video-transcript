import { startTimer } from '@beenotung/tslib/timer'
import { spawnAndWait } from '@beenotung/tslib/child_process'
import {
  createCanvas,
  ImageData,
  loadImage,
  CanvasRenderingContext2D,
} from 'canvas'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { readdir, rename, unlink, writeFile } from 'fs/promises'
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
let averageHeatmapDir = 'res/average-heatmap'
let snapshotHeatmapDir = 'res/snapshot-heatmap'
let snapshotDiffDir = 'res/snapshot-diff'

mkdirSync(downloadsDir, { recursive: true })
mkdirSync(snapshotDir, { recursive: true })
mkdirSync(croppedDir, { recursive: true })
mkdirSync(resultDir, { recursive: true })
mkdirSync(averageDir, { recursive: true })
mkdirSync(statsDir, { recursive: true })
mkdirSync(averageHeatmapDir, { recursive: true })
mkdirSync(snapshotHeatmapDir, { recursive: true })
mkdirSync(snapshotDiffDir, { recursive: true })

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
    // but the FPS and CH are not always present
    // e.g. 'ID EXT RESOLUTION |  FILESIZE  TBR PROTO | VCODEC         VBR ACODEC     ABR ASR MORE INFO'
    // e.g. '0  mp4 720x1280    30  2 |  15.39MiB 1022k http  | h264   960k aac    56k'
    let parts = line.split(' ').filter(part => part.length > 0)

    let audio_only = line.includes('audio only')
    let video_only = line.includes('video only')

    let id = parts[0]
    if (!id) continue

    let ext = parts[1]
    if (!isVideoExt(ext)) continue

    let resolution = parseResolution(parts[2])

    let fileSize = findFileSize(parts)

    formats.push({
      id,
      ext,
      resolution,
      fileSize,
      audio_only,
      video_only,
    })
  }
  console.dir({ allFormats: formats }, { depth: 20 })
  formats = formats.filter(
    format =>
      !format.audio_only &&
      isVideoExt(format.ext) &&
      format.resolution !== 'none',
  )
  formats = tryFilter(formats, format => format.video_only)
  console.dir({ selectedFormats: formats }, { depth: 20 })
  formats.sort((a, b) => {
    let aFileSize = a.fileSize ?? Number.MAX_SAFE_INTEGER
    let bFileSize = b.fileSize ?? Number.MAX_SAFE_INTEGER
    return aFileSize - bFileSize
  })
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

function isVideoExt(ext: string) {
  let exts = ['mp4', 'webm']
  return exts.includes(ext)
}

function parseResolution(text: string) {
  if (text === 'audio') return 'none' as const
  if (text === 'unknown') return 'unknown' as const
  // e.g. '720x1280'
  let parts = text.split('x')
  let width = +parts[0]
  let height = +parts[1]
  return { width, height }
}

function findFileSize(parts: string[]) {
  for (let part of parts) {
    try {
      let size = parseFileSize(part)
      if (size && Number.isFinite(size)) {
        return size
      }
    } catch (error) {
      continue
    }
  }
  return null
}

function parseFileSize(text: string) {
  text = text.replace('≈', '').replace('~', '').trim()
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
  if (url.hostname == 'm.facebook.com') {
    // e.g. 'https://m.facebook.com/watch/?v=xxxxx'
    let id = url.searchParams.get('v')!
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

let batchCounter = 0
function getBatchPrefix() {
  batchCounter++
  return `batch_${Date.now()}_${batchCounter}_`
}

/** Take multiple snapshots in a single ffmpeg run (one decode pass, one process). */
async function takeSnapshotsBatch(args: {
  inFile: string
  snapshots: Array<{ time: number; outFile: string }>
  onProgress?: () => void
}) {
  let { inFile, snapshots, onProgress } = args
  if (snapshots.length === 0) return
  // Small window so at most one frame per timestamp (avoid 2+ at 30fps+)
  let window = 0.001
  let selectTerms = snapshots
    .map(({ time }) => `between(t\\,${time}\\,${time + window})`)
    .join('+')
  let prefix = getBatchPrefix()
  let outPattern = join(snapshotDir, prefix + '%04d.jpg')
  let { stdout, stderr, code } = await spawnAndWait({
    cmd: 'ffmpeg',
    args: [
      '-y',
      '-i',
      inFile,
      '-v',
      'error',
      '-vf',
      `select='${selectTerms}'`,
      '-vsync',
      '0',
      '-q:v',
      '2',
      outPattern,
    ],
  })
  if (code !== 0) {
    console.error({ stdout, stderr, code })
    throw new Error('Failed to take snapshots batch')
  }
  for (let i = 0; i < snapshots.length; i++) {
    let batchPath = join(
      snapshotDir,
      prefix + (i + 1).toString().padStart(4, '0') + '.jpg',
    )
    if (!existsSync(batchPath)) {
      throw new Error(`Batch path not found: ${batchPath}`)
    }
    await rename(batchPath, snapshots[i].outFile)
    onProgress?.()
  }
  // Remove any extra frames ffmpeg produced (e.g. from overlapping windows)
  let files = await readdir(snapshotDir)
  for (let name of files) {
    if (name.startsWith(prefix) && name.endsWith('.jpg')) {
      await unlink(join(snapshotDir, name))
    }
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

function calculateCaptionRegion(args: {
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
  // skip top region in the screen
  // TODO detect title from upper/middle part, or maybe just use first frame as cover
  let skipTop = Math.floor(height * 0.4)
  for (let i = skipTop; i < brightness.length; i++) {
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

async function getImageData(args: {
  context: CanvasRenderingContext2D
  file: string
}) {
  let { context, file } = args
  let image = await loadImage(file)
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, image.width, image.height)
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
    if (duration - time < 0.1) {
      time = duration - 0.1
    }
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
  await takeSnapshotsBatch({
    inFile: videoFile,
    snapshots: newSnapshots.map(({ time, snapshotFile }) => ({
      time,
      outFile: snapshotFile,
    })),
    onProgress: () => timer.tick(),
  })
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

  let canvas = createCanvas(width, height)
  let context = canvas.getContext('2d')
  let averageImageData = (await getImageData({ context, file: averageFile }))
    .data

  timer.next('load average brightness')
  let averageBrightness = new Array(height)
    .fill(0)
    .map(() => new Array(width).fill(0))
  let offset = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = averageImageData[offset++]
      let g = averageImageData[offset++]
      let b = averageImageData[offset++]
      let a = averageImageData[offset++] / 255
      let brightness = ((r + g + b) / 3) * a
      averageBrightness[y][x] = brightness
    }
  }

  let averageHeatmapFile = join(averageHeatmapDir, `${filename}-${step}.png`)
  if (!existsSync(averageHeatmapFile)) {
    timer.next('scan snapshots for heatmap')
    timer.setEstimateProgress(snapshotFiles.length)
    let diffs = new Array(height).fill(0).map(() => new Array(width).fill(0))
    for (let snapshotFile of snapshotFiles) {
      let snapshotImageData = (
        await getImageData({
          context,
          file: snapshotFile,
        })
      ).data
      offset = 0
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let r = snapshotImageData[offset++]
          let g = snapshotImageData[offset++]
          let b = snapshotImageData[offset++]
          let a = snapshotImageData[offset++] / 255
          let brightness = ((r + g + b) / 3) * a
          diffs[y][x] += brightness - averageBrightness[y][x]
        }
      }
      timer.tick()
    }
    timer.next('normalize heatmap')
    let maxDiff = 0
    let minDiff = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let diff = diffs[y][x] / snapshotFiles.length
        maxDiff = Math.max(maxDiff, diff)
        minDiff = Math.min(minDiff, diff)
        diffs[y][x] = diff
      }
    }
    console.log()
    console.log('average heatmap diff range:', { max: maxDiff, min: minDiff })
    let diffRange = Math.max(Math.abs(maxDiff), Math.abs(minDiff))
    timer.next('generate average heatmap')
    let heatmapData = new ImageData(width, height)
    offset = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let diff = diffs[y][x]
        let value = diff / diffRange
        let r = 0
        let g = 0
        let b = 0
        let a = 255
        if (value > 0) {
          r = Math.round(value * 255)
        } else {
          b = Math.round(-value * 255)
        }
        heatmapData.data[offset++] = r
        heatmapData.data[offset++] = g
        heatmapData.data[offset++] = b
        heatmapData.data[offset++] = a
      }
    }
    context.putImageData(heatmapData, 0, 0)
    await writeFile(averageHeatmapFile, canvas.toBuffer('image/png'))
  }
  console.log({ averageHeatmapFile })

  timer.next('generate snapshot heatmaps')
  let newSnapshotHeatmapFiles = []
  for (let snapshotFile of snapshotFiles) {
    let snapshotHeatmapFile = join(
      snapshotHeatmapDir,
      `${basename(snapshotFile)}-${step}.png`,
    )
    if (!existsSync(snapshotHeatmapFile)) {
      newSnapshotHeatmapFiles.push({ snapshotFile, snapshotHeatmapFile })
    }
  }
  timer.setEstimateProgress(newSnapshotHeatmapFiles.length)
  for (let { snapshotFile, snapshotHeatmapFile } of newSnapshotHeatmapFiles) {
    let snapshotImageData = (
      await getImageData({
        context,
        file: snapshotFile,
      })
    ).data
    let diffs = new Array(height).fill(0).map(() => new Array(width).fill(0))
    let maxDiff = 0
    let minDiff = 0
    let offset = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = snapshotImageData[offset++]
        let g = snapshotImageData[offset++]
        let b = snapshotImageData[offset++]
        let a = snapshotImageData[offset++] / 255
        let brightness = ((r + g + b) / 3) * a
        let diff = brightness - averageBrightness[y][x]
        maxDiff = Math.max(maxDiff, diff)
        minDiff = Math.min(minDiff, diff)
        diffs[y][x] = diff
      }
    }
    let diffRange = Math.max(Math.abs(maxDiff), Math.abs(minDiff))
    let heatmapData = new ImageData(width, height)
    offset = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let diff = diffs[y][x]
        let value = diff / diffRange
        let r = 0
        let g = 0
        let b = 0
        let a = 255
        if (value > 0) {
          r = Math.round(value * 255)
        } else {
          b = Math.round(-value * 255)
        }
        heatmapData.data[offset++] = r
        heatmapData.data[offset++] = g
        heatmapData.data[offset++] = b
        heatmapData.data[offset++] = a
      }
    }
    context.putImageData(heatmapData, 0, 0)
    await writeFile(snapshotHeatmapFile, canvas.toBuffer('image/png'))
    timer.tick()
  }

  timer.next('generate snapshot diffs')
  let newSnapshotDiffFiles = []
  for (let snapshotFile of snapshotFiles) {
    let snapshotDiffFile = join(
      snapshotDiffDir,
      `${basename(snapshotFile)}-${step}.jpg`,
    )
    if (!existsSync(snapshotDiffFile)) {
      newSnapshotDiffFiles.push({ snapshotFile, snapshotDiffFile })
    }
  }
  timer.setEstimateProgress(newSnapshotDiffFiles.length)
  for (let { snapshotFile, snapshotDiffFile } of newSnapshotDiffFiles) {
    let snapshotImageData = (
      await getImageData({
        context,
        file: snapshotFile,
      })
    ).data
    let diffs = new Array(height).fill(0).map(() => new Array(width).fill(0))
    let maxDiff = 0
    let minDiff = 0
    let offset = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = snapshotImageData[offset++]
        let g = snapshotImageData[offset++]
        let b = snapshotImageData[offset++]
        let a = snapshotImageData[offset++] / 255
        let brightness = ((r + g + b) / 3) * a
        let diff = brightness - averageBrightness[y][x]
        maxDiff = Math.max(maxDiff, diff)
        minDiff = Math.min(minDiff, diff)
        diffs[y][x] = diff
      }
    }
    let diffRange = Math.max(Math.abs(maxDiff), Math.abs(minDiff))
    let imageData = new ImageData(width, height)
    offset = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let diff = diffs[y][x]
        let value = diff / diffRange
        let a = Math.abs(value) * 255
        imageData.data[offset + 0] = snapshotImageData[offset + 0] // r
        imageData.data[offset + 1] = snapshotImageData[offset + 1] // g
        imageData.data[offset + 2] = snapshotImageData[offset + 2] // b
        imageData.data[offset + 3] = a // a
        offset += 4
      }
    }
    context.putImageData(imageData, 0, 0)
    await writeFile(snapshotDiffFile, canvas.toBuffer('image/jpeg'))
    timer.tick()
  }

  let cropRegion = calculateCaptionRegion({
    width,
    height,
    data: averageImageData,
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
