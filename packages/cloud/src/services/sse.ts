//@ backend dafny
// spec/cloud/services/inference.md, "Story: Stream a reply in the shape clients read"

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

export function segmenter(): Segmenter {
  //@ ensures !\result.terminal && !\result.hasData && \result.line.length === 0
  return { line: [], cr: false, data: [], hasData: false, terminal: false }
}

//@ pure
export function chunkFrame(json: string): string {
  //@ ensures \result.startsWith("data: ") && \result.endsWith("\n\n")
  return "data: " + json + "\n\n"
}

//@ pure
export function isDone(event: number[]): boolean {
  return event.length === 6 && event[0] === 91 && event[1] === 68 && event[2] === 79 && event[3] === 78 && event[4] === 69 && event[5] === 93
}

//@ pure
function isDataField(line: number[]): boolean {
  return line.length >= 4 && line[0] === 100 && line[1] === 97 && line[2] === 116 && line[3] === 97 && (line.length === 4 || line[4] === 58)
}

//@ pure
function valueOf(line: number[]): number[] {
  //@ requires isDataField(line)
  if (line.length === 4) return []
  if (line.length > 5 && line[5] === 32) return line.slice(6)
  return line.slice(5)
}

//@ pure
function endLine(s: Segmenter, cr: boolean): Fed {
  //@ ensures \result.segmenter.line.length === 0 && \result.segmenter.terminal === s.terminal
  if (s.line.length === 0 && s.hasData) return { segmenter: { line: [], cr: cr, data: [], hasData: false, terminal: s.terminal }, events: [s.data] }
  if (s.line.length === 0) return { segmenter: { line: [], cr: cr, data: s.data, hasData: false, terminal: s.terminal }, events: [] }
  if (!isDataField(s.line)) return { segmenter: { line: [], cr: cr, data: s.data, hasData: s.hasData, terminal: s.terminal }, events: [] }
  const value = valueOf(s.line)
  return { segmenter: { line: [], cr: cr, data: s.hasData ? s.data.concat([10]).concat(value) : value, hasData: true, terminal: s.terminal }, events: [] }
}

//@ pure
export function pushByte(s: Segmenter, b: number): Fed {
  //@ ensures s.terminal ==> \result.segmenter === s && \result.events.length === 0
  if (s.terminal) return { segmenter: s, events: [] }
  if (b === 10 && s.cr) return { segmenter: { line: s.line, cr: false, data: s.data, hasData: s.hasData, terminal: false }, events: [] }
  if (b === 10 || b === 13) return endLine(s, b === 13)
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
  return { segmenter: { line: line, cr: cr, data: data, hasData: hasData, terminal: s.terminal }, events: events }
}

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
