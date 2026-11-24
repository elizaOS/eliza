//@ backend dafny
// spec/cloud/index.md, "A streamed answer sends complete OpenAI frames and settles the same hold"

export interface Segmenter {
  line: number[]
  cr: boolean
  data: number[]
  hasData: boolean
  terminal: boolean
}

export interface Fed {
  segmenter: Segmenter
  events: number[][]
}

export const doneFrame = "data: [DONE]\n\n"

/** @throws {never} */
export function segmenter(): Segmenter {
  //@ ensures !\result.terminal && !\result.hasData && \result.line.length === 0
  return { line: [], cr: false, data: [], hasData: false, terminal: false }
}

//@ pure
/** @throws {never} */
export function chunkFrame(json: string): string {
  //@ ensures \result.startsWith("data: ") && \result.endsWith("\n\n")
  return "data: " + json + "\n\n"
}

//@ pure
/** @throws {never} */
export function isDone(event: number[]): boolean {
  return event.length === 6 && event[0] === 91 && event[1] === 68 && event[2] === 79 && event[3] === 78 && event[4] === 69 && event[5] === 93
}

//@ pure
function isDataField(line: number[]): boolean {
  return line.length >= 4 && line[0] === 100 && line[1] === 97 && line[2] === 116 && line[3] === 97 && (line.length === 4 || line[4] === 58)
}

type SseLine = { kind: "Blank" } | { kind: "Ignored" } | { kind: "Data"; start: number }

//@ pure
export function classifySseLine(line: number[]): SseLine {
  if (line.length === 0) return { kind: "Blank" }
  if (!isDataField(line)) return { kind: "Ignored" }
  if (line.length === 4) return { kind: "Data", start: 4 }
  return { kind: "Data", start: line.length > 5 && line[5] === 32 ? 6 : 5 }
}

//@ pure
export function classifySseByte(cr: boolean, byte: number): "Skip" | "CarriageReturn" | "LineFeed" | "Data" {
  if (byte === 10) return cr ? "Skip" : "LineFeed"
  return byte === 13 ? "CarriageReturn" : "Data"
}

//@ pure
function endLine(s: Segmenter, cr: boolean): Fed {
  //@ ensures \result.segmenter.line.length === 0 && \result.segmenter.terminal === s.terminal
  const line = classifySseLine(s.line)
  if (line.kind === "Blank" && s.hasData) return { segmenter: { line: [], cr: cr, data: [], hasData: false, terminal: s.terminal }, events: [s.data] }
  if (line.kind !== "Data") return { segmenter: { line: [], cr: cr, data: s.data, hasData: s.hasData, terminal: s.terminal }, events: [] }
  const value = s.line.slice(line.start)
  return { segmenter: { line: [], cr: cr, data: s.hasData ? s.data.concat([10]).concat(value) : value, hasData: true, terminal: s.terminal }, events: [] }
}

//@ pure
export function pushByte(s: Segmenter, b: number): Fed {
  //@ ensures s.terminal ==> \result.segmenter === s && \result.events.length === 0
  if (s.terminal) return { segmenter: s, events: [] }
  const kind = classifySseByte(s.cr, b)
  if (kind === "Skip") return { segmenter: { line: s.line, cr: false, data: s.data, hasData: s.hasData, terminal: false }, events: [] }
  if (kind !== "Data") return endLine(s, kind === "CarriageReturn")
  return { segmenter: { line: s.line.concat([b]), cr: false, data: s.data, hasData: s.hasData, terminal: false }, events: [] }
}

//@ pure
export function fed(s: Segmenter, bytes: number[]): Fed {
  //@ decreases bytes.length
  if (bytes.length === 0) return { segmenter: s, events: [] }
  const before = fed(s, bytes.slice(0, bytes.length - 1))
  const last = pushByte(before.segmenter, bytes[bytes.length - 1])
  return { segmenter: last.segmenter, events: before.events.concat(last.events) }
}

//@ pure
export function lawEventsDoNotDependOnChunking(s: Segmenter, a: number[], b: number[]): boolean {
  //@ ensures fed(s, a.concat(b)).segmenter === fed(fed(s, a).segmenter, b).segmenter
  //@ ensures fed(s, a.concat(b)).events === fed(s, a).events.concat(fed(fed(s, a).segmenter, b).events)
  return true
}

/** @throws {never} */
export function feed(s: Segmenter, chunk: number[]): Fed {
  //@ ensures \result === fed(s, chunk)
  let cr = s.cr
  let data = s.data
  let hasData = s.hasData
  let line = s.line.slice()
  let events: number[][] = []
  let i = 0
  while (i < chunk.length) {
    //@ invariant 0 <= i && i <= chunk.length
    //@ invariant fed(s, chunk.slice(0, i)).segmenter === { line: line, cr: cr, data: data, hasData: hasData, terminal: s.terminal }
    //@ invariant fed(s, chunk.slice(0, i)).events === events
    //@ assert chunk.slice(0, i + 1).slice(0, i) === chunk.slice(0, i)
    const b = chunk[i]
    if (!s.terminal && (b === 10 || b === 13)) {
      const r = pushByte({ line: line, cr: cr, data: data, hasData: hasData, terminal: false }, b)
      line = r.segmenter.line
      cr = r.segmenter.cr
      data = r.segmenter.data
      hasData = r.segmenter.hasData
      events = events.concat(r.events)
    } else if (!s.terminal) {
      line.push(b)
      cr = false
    }
    i = i + 1
  }
  //@ assert chunk.slice(0, chunk.length) === chunk
  return { segmenter: { line: line, cr: cr, data: data, hasData: hasData, terminal: s.terminal }, events: events }
}

/** @throws {never} */
export function finish(s: Segmenter): Fed {
  //@ ensures \result.segmenter.terminal && \result.events.length <= 1
  //@ ensures s.terminal ==> \result.events.length === 0
  //@ ensures !s.terminal && (s.hasData || isDataField(s.line)) ==> \result.events.length === 1
  if (s.terminal) return { segmenter: s, events: [] }
  const ended = endLine(s, false)
  const flushed = endLine(ended.segmenter, false)
  return { segmenter: { line: [], cr: false, data: [], hasData: false, terminal: true }, events: ended.events.concat(flushed.events) }
}

export function abort(): Segmenter {
  //@ ensures \result.terminal && !\result.hasData && \result.line.length === 0
  return { line: [], cr: false, data: [], hasData: false, terminal: true }
}

//@ pure
export function usageFrame(json: string): string {
  //@ ensures \result === chunkFrame(json)
  return chunkFrame(json)
}

//@ pure
/** @throws {never} */
export function errorFrame(refusalJson: string): string {
  //@ ensures \result === chunkFrame(refusalJson)
  return chunkFrame(refusalJson)
}

export interface Utf8 {
  codePoint: number
  needed: number
  seen: number
}

export interface Decoded {
  decoder: Utf8
  codePoints: number[]
}

export const replacement = 65533

export function utf8(): Utf8 {
  //@ ensures utf8Ok(\result)
  return { codePoint: 0, needed: 0, seen: 0 }
}

//@ pure
export function isScalar(c: number): boolean {
  return 0 <= c && c <= 1114111 && !(55296 <= c && c <= 57343)
}

//@ pure
export function utf8Ok(d: Utf8): boolean {
  if (d.needed === 0) return d.seen === 0 && d.codePoint === 0
  if (d.needed === 1) return d.seen === 0 && 2 <= d.codePoint && d.codePoint <= 31
  if (d.needed === 2 && d.seen === 0) return 0 <= d.codePoint && d.codePoint <= 15
  if (d.needed === 2 && d.seen === 1) return 32 <= d.codePoint && d.codePoint <= 1023 && !(864 <= d.codePoint && d.codePoint <= 895)
  if (d.needed === 3 && d.seen === 0) return 0 <= d.codePoint && d.codePoint <= 4
  if (d.needed === 3 && d.seen === 1) return 16 <= d.codePoint && d.codePoint <= 271
  return d.needed === 3 && d.seen === 2 && 1024 <= d.codePoint && d.codePoint <= 17407
}

//@ pure
function lowest(d: Utf8): number {
  if (d.seen === 0 && d.codePoint === 0 && d.needed === 2) return 160
  if (d.seen === 0 && d.codePoint === 0 && d.needed === 3) return 144
  return 128
}

//@ pure
function highest(d: Utf8): number {
  if (d.seen === 0 && d.codePoint === 13 && d.needed === 2) return 159
  if (d.seen === 0 && d.codePoint === 4 && d.needed === 3) return 143
  return 191
}

//@ pure
function leadByte(b: number): Decoded {
  //@ ensures utf8Ok(\result.decoder) && \result.codePoints.length <= 1
  //@ ensures forall(k, 0 <= k && k < \result.codePoints.length ==> isScalar(\result.codePoints[k]))
  if (0 <= b && b <= 127) return { decoder: { codePoint: 0, needed: 0, seen: 0 }, codePoints: [b] }
  if (194 <= b && b <= 223) return { decoder: { codePoint: b - 192, needed: 1, seen: 0 }, codePoints: [] }
  if (224 <= b && b <= 239) return { decoder: { codePoint: b - 224, needed: 2, seen: 0 }, codePoints: [] }
  if (240 <= b && b <= 244) return { decoder: { codePoint: b - 240, needed: 3, seen: 0 }, codePoints: [] }
  return { decoder: { codePoint: 0, needed: 0, seen: 0 }, codePoints: [replacement] }
}

//@ pure
export function pushUtf8(d: Utf8, b: number): Decoded {
  //@ ensures \result.codePoints.length <= 2
  //@ ensures utf8Ok(d) ==> utf8Ok(\result.decoder)
  //@ ensures utf8Ok(d) ==> forall(k, 0 <= k && k < \result.codePoints.length ==> isScalar(\result.codePoints[k]))
  if (d.needed === 0) return leadByte(b)
  if (b < lowest(d) || b > highest(d)) {
    const again = leadByte(b)
    return { decoder: again.decoder, codePoints: [replacement].concat(again.codePoints) }
  }
  const codePoint = d.codePoint * 64 + (b - 128)
  if (d.seen + 1 === d.needed) return { decoder: { codePoint: 0, needed: 0, seen: 0 }, codePoints: [codePoint] }
  return { decoder: { codePoint: codePoint, needed: d.needed, seen: d.seen + 1 }, codePoints: [] }
}

//@ pure
export function decoded(d: Utf8, bytes: number[]): Decoded {
  //@ decreases bytes.length
  //@ ensures utf8Ok(d) ==> utf8Ok(\result.decoder)
  //@ ensures utf8Ok(d) ==> forall(k, 0 <= k && k < \result.codePoints.length ==> isScalar(\result.codePoints[k]))
  if (bytes.length === 0) return { decoder: d, codePoints: [] }
  const before = decoded(d, bytes.slice(0, bytes.length - 1))
  const last = pushUtf8(before.decoder, bytes[bytes.length - 1])
  return { decoder: last.decoder, codePoints: before.codePoints.concat(last.codePoints) }
}

//@ pure
export function lawDecodingDoesNotDependOnChunking(d: Utf8, a: number[], b: number[]): boolean {
  //@ ensures decoded(d, a.concat(b)).decoder === decoded(decoded(d, a).decoder, b).decoder
  //@ ensures decoded(d, a.concat(b)).codePoints === decoded(d, a).codePoints.concat(decoded(decoded(d, a).decoder, b).codePoints)
  return true
}

export function decode(d: Utf8, chunk: number[]): Decoded {
  //@ ensures \result === decoded(d, chunk)
  //@ ensures utf8Ok(d) ==> utf8Ok(\result.decoder)
  //@ ensures utf8Ok(d) ==> forall(k, 0 <= k && k < \result.codePoints.length ==> isScalar(\result.codePoints[k]))
  let current = d
  const out: number[] = []
  let i = 0
  while (i < chunk.length) {
    //@ invariant 0 <= i && i <= chunk.length
    //@ invariant decoded(d, chunk.slice(0, i)) === { decoder: current, codePoints: out }
    //@ invariant utf8Ok(d) ==> utf8Ok(current)
    //@ invariant utf8Ok(d) ==> forall(k, 0 <= k && k < out.length ==> isScalar(out[k]))
    //@ assert chunk.slice(0, i + 1).slice(0, i) === chunk.slice(0, i)
    const r = pushUtf8(current, chunk[i])
    if (r.codePoints.length > 0) out.push(r.codePoints[0])
    if (r.codePoints.length > 1) out.push(r.codePoints[1])
    current = r.decoder
    i = i + 1
  }
  //@ assert chunk.slice(0, chunk.length) === chunk
  return { decoder: current, codePoints: out }
}

export function endUtf8(d: Utf8): number[] {
  //@ ensures \result.length <= 1
  //@ ensures forall(k, 0 <= k && k < \result.length ==> isScalar(\result[k]))
  if (d.needed === 0) return []
  return [replacement]
}

export function utf8Text(bytes: number[]): number[] {
  //@ ensures forall(k, 0 <= k && k < \result.length ==> isScalar(\result[k]))
  const whole = decode(utf8(), bytes)
  return whole.codePoints.concat(endUtf8(whole.decoder))
}
