// spec/localInference/speechRoute.md, "Story: Hear a reply on the admitted speech route"
export interface Pcm {
  readonly sampleRate: number
  readonly samples: Float32Array
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  [...text].every((letter, index) => bytes[at + index] === letter.charCodeAt(0))

/** @throws {never} */
export function decodeWav(bytes: Uint8Array): Pcm | undefined {
  if (bytes.byteLength < 44 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE")) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 12
  let format: { sampleRate: number; channels: number; bits: number; encoding: number } | undefined
  while (at + 8 <= bytes.byteLength) {
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (body + size > bytes.byteLength) return undefined
    if (ascii(bytes, at, "fmt ") && size >= 16) {
      format = { encoding: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) }
    } else if (ascii(bytes, at, "data")) {
      if (format === undefined || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16 || format.sampleRate === 0) return undefined
      const samples = new Float32Array(Math.floor(size / 2))
      for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(body + index * 2, true) / 32768
      return { sampleRate: format.sampleRate, samples }
    }
    at = body + size + (size % 2)
  }
  return undefined
}

/** @throws {never} */
export function encodeWav(pcm: Pcm): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => { for (let index = 0; index < value.length; index++) bytes[at + index] = value.charCodeAt(index) }
  text(0, "RIFF")
  view.setUint32(4, bytes.byteLength - 8, true)
  text(8, "WAVE")
  text(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, pcm.sampleRate, true)
  view.setUint32(28, pcm.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, pcm.samples.length * 2, true)
  pcm.samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true))
  return bytes
}
