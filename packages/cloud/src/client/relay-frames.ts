//@ backend dafny
// spec/cloud/services/speechRelay.md, "The wire is version 1 with 16 kHz mono PCM16 and bounded frames"
import { type RelayErrorCode, type RelayReason, type SttEventKind, maxControlBytes, maxDownlinkPcmBytes, maxHelloTokenChars, maxTranscriptChars, maxTtsTextChars, maxUplinkChunkBytes, maxUtteranceIdChars, relayChannels, relaySampleRate, relayVersion, validDownlinkAudio, validPcm } from "../../gen/cloud__services__speechRelay.ts"

export type DeviceWire =
  | { kind: "Hello"; token: number[]; errorReasons: boolean; extend: boolean }
  | { kind: "Prepare"; id: number[] }
  | { kind: "Tts"; id: number[]; text: number[]; flush: boolean }
  | { kind: "Finish"; id: number[] }
  | { kind: "Cancel"; id: number[] }
  | { kind: "Stop" }
  | { kind: "Uplink"; pcm: number[] }
  | { kind: "DeviceRefused" }

export type RelayWire =
  | { kind: "Ready"; expiresAt: number[] }
  | { kind: "Stt"; event: SttEventKind; transcript: number[] }
  | { kind: "Prepared"; id: number[] }
  | { kind: "Flushed"; id: number[] }
  | { kind: "Completed"; id: number[] }
  | { kind: "Extended"; expiresAt: number[] }
  | { kind: "Failed"; code: RelayErrorCode; reason: RelayReason }
  | { kind: "Audio"; id: number[]; pcm: number[] }
  | { kind: "RelayRefused" }

export type Written = { kind: "Written"; bytes: number[] } | { kind: "Unwritable" }

export type JsonValue =
  | { kind: "JsonText"; bytes: number[] }
  | { kind: "JsonFlag"; on: boolean }
  | { kind: "JsonCount"; n: number }
  | { kind: "JsonObject"; fields: JsonField[] }
  | { kind: "JsonAbsent" }

export interface JsonField { key: number[]; value: JsonValue }

interface ReadText { ok: boolean; at: number; bytes: number[] }
interface ReadValue { ok: boolean; at: number; value: JsonValue }
interface ReadFields { ok: boolean; at: number; fields: JsonField[] }

//@ pure
export function isIdByte(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45
}

//@ pure
export function idBytesValid(id: number[]): boolean {
  return id.length >= 1 && id.length <= maxUtteranceIdChars && id.every((c: number) => isIdByte(c))
}

//@ pure
export function validHelloToken(units: number): boolean {
  return units >= 1 && units <= maxHelloTokenChars
}

//@ pure
export function validTtsText(units: number, blank: boolean): boolean {
  return units >= 1 && units <= maxTtsTextChars && !blank
}

//@ pure
export function validUplink(bytes: number): boolean {
  return validPcm(bytes, maxUplinkChunkBytes)
}

//@ pure
export function encodeAudio(id: number[], pcm: number[]): number[] {
  return [1, id.length].concat(id).concat(pcm)
}

//@ pure
export function audioFrameFits(frame: number[]): boolean {
  return frame.length >= 2 && frame[0] === 1 && validDownlinkAudio(frame[1], frame.length - 2 - frame[1])
}

//@ pure
export function lawEncodedAudioFits(id: number[], pcm: number[]): boolean { // eslint-disable-line @typescript-eslint/no-unused-vars -- Law parameters are used by the checked LemmaScript postcondition.
  //@ ensures audioFrameFits(encodeAudio(id, pcm)) === validDownlinkAudio(id.length, pcm.length)
  return true
}

//@ pure
export function utf16Units(text: number[]): number {
  return text.filter((c: number) => c < 128 || c >= 192).length + text.filter((c: number) => c >= 240).length
}

//@ pure
export function spaceWidth(t: number[], i: number): number {
  //@ requires 0 <= i && i < t.length
  //@ ensures 0 <= \result && i + \result <= t.length
  const a = t[i]
  if (a === 9 || a === 10 || a === 11 || a === 12 || a === 13 || a === 32) return 1
  if (i + 1 >= t.length) return 0
  const b = t[i + 1]
  if (a === 194 && b === 160) return 2
  if (i + 2 >= t.length) return 0
  const c = t[i + 2]
  if (a === 225 && b === 154 && c === 128) return 3
  if (a === 226 && b === 128 && ((c >= 128 && c <= 138) || c === 168 || c === 169 || c === 175)) return 3
  if (a === 226 && b === 129 && c === 159) return 3
  if (a === 227 && b === 128 && c === 128) return 3
  if (a === 239 && b === 187 && c === 191) return 3
  return 0
}

//@ pure
export function blankFrom(t: number[], i: number): boolean {
  //@ requires 0 <= i && i <= t.length
  //@ decreases t.length - i
  if (i >= t.length) return true
  const w = spaceWidth(t, i)
  if (w === 0) return false
  return blankFrom(t, i + w)
}

//@ pure
export function blankText(t: number[]): boolean {
  return blankFrom(t, 0)
}

//@ pure
function isContinuation(c: number): boolean {
  return c >= 128 && c <= 191
}

//@ pure
function utf8Width(b: number[], i: number): number {
  //@ requires 0 <= i && i < b.length
  //@ ensures 0 <= \result && i + \result <= b.length
  const a = b[i]
  if (a >= 0 && a < 128) return 1
  if (a < 194 || a > 244 || i + 1 >= b.length) return 0
  const c = b[i + 1]
  if (a < 224) return isContinuation(c) ? 2 : 0
  const lo = a === 224 ? 160 : a === 240 ? 144 : 128
  const hi = a === 237 ? 159 : a === 244 ? 143 : 191
  if (c < lo || c > hi || i + 2 >= b.length || !isContinuation(b[i + 2])) return 0
  if (a < 240) return 3
  if (i + 3 >= b.length || !isContinuation(b[i + 3])) return 0
  return 4
}

export function utf8Valid(b: number[]): boolean {
  let i = 0
  while (i < b.length) {
    //@ invariant 0 <= i && i <= b.length
    //@ decreases b.length - i
    const w = utf8Width(b, i)
    if (w === 0) return false
    i = i + w
  }
  return true
}

function ascii(s: string): number[] {
  const out: number[] = []
  let i = 0
  while (i < s.length) {
    //@ invariant 0 <= i && i <= s.length
    //@ decreases s.length - i
    out.push(s.charCodeAt(i))
    i = i + 1
  }
  return out
}

function sameBytes(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  let i = 0
  while (i < a.length) {
    //@ invariant 0 <= i && i <= a.length && a.length === b.length
    //@ decreases a.length - i
    if (a[i] !== b[i]) return false
    i = i + 1
  }
  return true
}

function skipSpace(b: number[], start: number): number {
  //@ requires 0 <= start && start <= b.length
  //@ ensures start <= \result && \result <= b.length
  let i = start
  while (i < b.length && (b[i] === 32 || b[i] === 9 || b[i] === 10 || b[i] === 13)) {
    //@ invariant start <= i && i <= b.length
    //@ decreases b.length - i
    i = i + 1
  }
  return i
}

//@ pure
function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 65 && c <= 70) return c - 55
  if (c >= 97 && c <= 102) return c - 87
  return -1
}

//@ pure
function hex4(b: number[], i: number): number {
  //@ requires 0 <= i
  //@ ensures \result >= -1 && \result < 65536
  if (i + 4 > b.length) return -1
  const d0 = hexDigit(b[i])
  const d1 = hexDigit(b[i + 1])
  const d2 = hexDigit(b[i + 2])
  const d3 = hexDigit(b[i + 3])
  if (d0 < 0 || d1 < 0 || d2 < 0 || d3 < 0) return -1
  return d0 * 4096 + d1 * 256 + d2 * 16 + d3
}

//@ pure
function utf8Of(cp: number): number[] {
  //@ requires 0 <= cp && cp < 1114112
  if (cp < 128) return [cp]
  if (cp < 2048) return [192 + Math.floor(cp / 64), 128 + cp % 64]
  if (cp < 65536) return [224 + Math.floor(cp / 4096), 128 + Math.floor(cp / 64) % 64, 128 + cp % 64]
  return [240 + Math.floor(cp / 262144), 128 + Math.floor(cp / 4096) % 64, 128 + Math.floor(cp / 64) % 64, 128 + cp % 64]
}

//@ pure
function shortEscape(e: number): number {
  if (e === 34 || e === 92 || e === 47) return e
  if (e === 98) return 8
  if (e === 102) return 12
  if (e === 110) return 10
  if (e === 114) return 13
  if (e === 116) return 9
  return -1
}

function readText(b: number[], start: number): ReadText {
  //@ requires 0 <= start && start <= b.length
  //@ ensures \result.ok ==> start < \result.at && \result.at <= b.length
  const out: number[] = []
  let i = start
  while (i < b.length) {
    //@ invariant start <= i && i <= b.length
    //@ decreases b.length - i
    const c = b[i]
    if (c === 34) return { ok: true, at: i + 1, bytes: out }
    if (c < 32) return { ok: false, at: start, bytes: [] }
    if (c !== 92) {
      out.push(c)
      i = i + 1
    } else {
      if (i + 1 >= b.length) return { ok: false, at: start, bytes: [] }
      const e = b[i + 1]
      const short = shortEscape(e)
      if (short >= 0) {
        out.push(short)
        i = i + 2
      } else {
        if (e !== 117) return { ok: false, at: start, bytes: [] }
        const high = hex4(b, i + 2)
        if (high < 0 || (high >= 56320 && high <= 57343)) return { ok: false, at: start, bytes: [] }
        if (high >= 55296 && high <= 56319) {
          if (i + 7 >= b.length || b[i + 6] !== 92 || b[i + 7] !== 117) return { ok: false, at: start, bytes: [] }
          const low = hex4(b, i + 8)
          if (low < 56320 || low > 57343) return { ok: false, at: start, bytes: [] }
          out = out.concat(utf8Of(65536 + (high - 55296) * 1024 + (low - 56320)))
          i = i + 12
        } else {
          out = out.concat(utf8Of(high))
          i = i + 6
        }
      }
    }
  }
  return { ok: false, at: start, bytes: [] }
}

function readCount(b: number[], start: number): ReadValue {
  //@ requires 0 <= start && start <= b.length
  //@ ensures \result.ok ==> start < \result.at && \result.at <= b.length
  let n = 0
  let i = start
  while (i < b.length && b[i] >= 48 && b[i] <= 57 && i - start < 15) {
    //@ invariant start <= i && i <= b.length && n >= 0
    //@ decreases b.length - i
    n = n * 10 + (b[i] - 48)
    i = i + 1
  }
  if (i === start || (i - start > 1 && b[start] === 48)) return { ok: false, at: start, value: { kind: "JsonAbsent" } }
  if (i < b.length && ((b[i] >= 48 && b[i] <= 57) || b[i] === 46 || b[i] === 101 || b[i] === 69)) return { ok: false, at: start, value: { kind: "JsonAbsent" } }
  return { ok: true, at: i, value: { kind: "JsonCount", n: n } }
}

function readWord(b: number[], start: number, word: number[]): boolean {
  //@ requires 0 <= start && start <= b.length
  //@ ensures \result ==> start + word.length <= b.length
  if (start + word.length > b.length) return false
  return sameBytes(b.slice(start, start + word.length), word)
}

function readValue(b: number[], start: number, depth: number): ReadValue {
  //@ requires 0 <= start && start <= b.length && depth >= 0
  //@ ensures \result.ok ==> start < \result.at && \result.at <= b.length
  //@ decreases 2 * depth
  if (start >= b.length) return { ok: false, at: start, value: { kind: "JsonAbsent" } }
  const c = b[start]
  if (c === 34) {
    const text = readText(b, start + 1)
    return { ok: text.ok, at: text.ok ? text.at : start, value: { kind: "JsonText", bytes: text.bytes } }
  }
  if (c === 116 && readWord(b, start, [116, 114, 117, 101])) return { ok: true, at: start + 4, value: { kind: "JsonFlag", on: true } }
  if (c === 102 && readWord(b, start, [102, 97, 108, 115, 101])) return { ok: true, at: start + 5, value: { kind: "JsonFlag", on: false } }
  if (c >= 48 && c <= 57) return readCount(b, start)
  if (c === 123 && depth > 0) {
    const nested = readObject(b, start, depth - 1)
    return { ok: nested.ok, at: nested.ok ? nested.at : start, value: { kind: "JsonObject", fields: nested.fields } }
  }
  return { ok: false, at: start, value: { kind: "JsonAbsent" } }
}

function hasKey(fields: JsonField[], key: number[]): boolean {
  let i = 0
  while (i < fields.length) {
    //@ invariant 0 <= i && i <= fields.length
    //@ decreases fields.length - i
    if (sameBytes(fields[i].key, key)) return true
    i = i + 1
  }
  return false
}

function readObject(b: number[], start: number, depth: number): ReadFields {
  //@ requires 0 <= start && start <= b.length && depth >= 0
  //@ ensures \result.ok ==> start < \result.at && \result.at <= b.length
  //@ decreases 2 * depth + 1
  if (start >= b.length || b[start] !== 123) return { ok: false, at: start, fields: [] }
  const fields: JsonField[] = []
  let i = skipSpace(b, start + 1)
  if (i < b.length && b[i] === 125) return { ok: true, at: i + 1, fields: fields }
  while (i < b.length) {
    //@ invariant start < i && i <= b.length
    //@ decreases b.length - i
    if (b[i] !== 34) return { ok: false, at: start, fields: [] }
    const key = readText(b, i + 1)
    if (!key.ok || hasKey(fields, key.bytes)) return { ok: false, at: start, fields: [] }
    const colon = skipSpace(b, key.at)
    if (colon >= b.length || b[colon] !== 58) return { ok: false, at: start, fields: [] }
    const value = readValue(b, skipSpace(b, colon + 1), depth)
    if (!value.ok) return { ok: false, at: start, fields: [] }
    fields.push({ key: key.bytes, value: value.value })
    const next = skipSpace(b, value.at)
    if (next >= b.length) return { ok: false, at: start, fields: [] }
    if (b[next] === 125) return { ok: true, at: next + 1, fields: fields }
    if (b[next] !== 44) return { ok: false, at: start, fields: [] }
    i = skipSpace(b, next + 1)
  }
  return { ok: false, at: start, fields: [] }
}

function readJson(b: number[], depth: number): ReadFields {
  //@ requires depth >= 0
  const object = readObject(b, skipSpace(b, 0), depth)
  if (!object.ok || skipSpace(b, object.at) !== b.length) return { ok: false, at: 0, fields: [] }
  return object
}

function fieldOf(fields: JsonField[], key: string): JsonValue {
  const wanted = ascii(key)
  let i = 0
  while (i < fields.length) {
    //@ invariant 0 <= i && i <= fields.length
    //@ decreases fields.length - i
    if (sameBytes(fields[i].key, wanted)) return fields[i].value
    i = i + 1
  }
  return { kind: "JsonAbsent" }
}

function onlyKeys(fields: JsonField[], allowed: string[]): boolean {
  let i = 0
  while (i < fields.length) {
    //@ invariant 0 <= i && i <= fields.length
    //@ decreases fields.length - i
    let known = false
    let j = 0
    while (j < allowed.length) {
      //@ invariant 0 <= j && j <= allowed.length
      //@ decreases allowed.length - j
      if (sameBytes(fields[i].key, ascii(allowed[j]))) known = true
      j = j + 1
    }
    if (!known) return false
    i = i + 1
  }
  return true
}

function textIs(v: JsonValue, word: string): boolean {
  if (v.kind !== "JsonText") return false
  return sameBytes(v.bytes, ascii(word))
}

//@ pure
function optionalTrue(v: JsonValue): boolean {
  return v.kind === "JsonAbsent" || (v.kind === "JsonFlag" && v.on)
}

//@ pure
function optionalFlag(v: JsonValue): boolean {
  return v.kind === "JsonAbsent" || v.kind === "JsonFlag"
}

//@ pure
function flagOn(v: JsonValue): boolean {
  return v.kind === "JsonFlag" && v.on
}

//@ pure
function idValue(v: JsonValue): number[] {
  if (v.kind === "JsonText" && idBytesValid(v.bytes)) return v.bytes
  return []
}

export function readDevice(b: number[], binary: boolean): DeviceWire {
  //@ ensures (binary && validUplink(b.length)) ==> (\result.kind === "Uplink" && \result.pcm === b)
  //@ ensures \result.kind === "Uplink" ==> binary && validUplink(\result.pcm.length)
  //@ ensures (!binary && b.length > maxControlBytes) ==> \result.kind === "DeviceRefused"
  //@ ensures \result.kind === "Hello" ==> validHelloToken(utf16Units(\result.token))
  //@ ensures \result.kind === "Tts" ==> idBytesValid(\result.id) && validTtsText(utf16Units(\result.text), blankText(\result.text))
  //@ ensures \result.kind === "Prepare" ==> idBytesValid(\result.id)
  //@ ensures \result.kind === "Finish" ==> idBytesValid(\result.id)
  //@ ensures \result.kind === "Cancel" ==> idBytesValid(\result.id)
  if (binary) return validUplink(b.length) ? { kind: "Uplink", pcm: b } : { kind: "DeviceRefused" }
  if (b.length > maxControlBytes || !utf8Valid(b)) return { kind: "DeviceRefused" }
  const json = readJson(b, 0)
  if (!json.ok) return { kind: "DeviceRefused" }
  const f = json.fields
  const t = fieldOf(f, "t")
  if (textIs(t, "hello")) {
    const token = fieldOf(f, "token")
    const errorReasons = fieldOf(f, "errorReasons")
    const extend = fieldOf(f, "extend")
    if (!onlyKeys(f, ["t", "token", "errorReasons", "extend"]) || token.kind !== "JsonText" || !validHelloToken(utf16Units(token.bytes)) || !optionalTrue(errorReasons) || !optionalTrue(extend)) return { kind: "DeviceRefused" }
    return { kind: "Hello", token: token.bytes, errorReasons: flagOn(errorReasons), extend: flagOn(extend) }
  }
  if (textIs(t, "stop")) return f.length === 1 ? { kind: "Stop" } : { kind: "DeviceRefused" }
  const id = idValue(fieldOf(f, "id"))
  if (!idBytesValid(id)) return { kind: "DeviceRefused" }
  if (f.length === 2 && textIs(t, "prepare")) return { kind: "Prepare", id: id }
  if (f.length === 2 && textIs(t, "finish")) return { kind: "Finish", id: id }
  if (f.length === 2 && textIs(t, "cancel")) return { kind: "Cancel", id: id }
  if (!textIs(t, "tts") || !onlyKeys(f, ["t", "id", "text", "flush"])) return { kind: "DeviceRefused" }
  const text = fieldOf(f, "text")
  const flush = fieldOf(f, "flush")
  if (text.kind !== "JsonText" || !optionalFlag(flush)) return { kind: "DeviceRefused" }
  const units = utf16Units(text.bytes)
  if (units > maxTtsTextChars || !validTtsText(units, blankText(text.bytes))) return { kind: "DeviceRefused" }
  return { kind: "Tts", id: id, text: text.bytes, flush: flagOn(flush) }
}

//@ pure
export function readAudio(frame: number[]): RelayWire {
  if (frame.length < 3 || frame[0] !== 1) return { kind: "RelayRefused" }
  const n = frame[1]
  if (n < 1 || n > maxUtteranceIdChars || frame.length < 2 + n) return { kind: "RelayRefused" }
  const id = frame.slice(2, 2 + n)
  const pcm = frame.slice(2 + n)
  if (!idBytesValid(id) || !validPcm(pcm.length, maxDownlinkPcmBytes)) return { kind: "RelayRefused" }
  return { kind: "Audio", id: id, pcm: pcm }
}

//@ pure
export function lawAudioRoundTrips(id: number[], pcm: number[]): boolean { // eslint-disable-line @typescript-eslint/no-unused-vars -- Law parameters are used by the checked LemmaScript postcondition.
  //@ ensures (idBytesValid(id) && validPcm(pcm.length, maxDownlinkPcmBytes)) ==> (readAudio(encodeAudio(id, pcm)).kind === "Audio" && readAudio(encodeAudio(id, pcm)).id === id && readAudio(encodeAudio(id, pcm)).pcm === pcm)
  return true
}

//@ pure
export function lawReadAudioIsCanonical(frame: number[]): boolean { // eslint-disable-line @typescript-eslint/no-unused-vars -- Law parameters are used by the checked LemmaScript postcondition.
  //@ ensures readAudio(frame).kind === "Audio" ==> encodeAudio(readAudio(frame).id, readAudio(frame).pcm) === frame
  return true
}

function sttKindOf(v: JsonValue): number {
  //@ ensures -1 <= \result && \result < 6
  if (textIs(v, "connected")) return 0
  if (textIs(v, "start-of-turn")) return 1
  if (textIs(v, "turn-resumed")) return 2
  if (textIs(v, "end-of-turn")) return 3
  if (textIs(v, "transcript-update")) return 4
  if (textIs(v, "eager-end-of-turn")) return 5
  return -1
}

function errorCodeOfWire(v: JsonValue): number {
  //@ ensures -1 <= \result && \result < 4
  if (textIs(v, "unauthorized")) return 0
  if (textIs(v, "protocol")) return 1
  if (textIs(v, "unavailable")) return 2
  if (textIs(v, "closed")) return 3
  return -1
}

function readStt(f: JsonField[]): RelayWire {
  //@ ensures \result.kind === "Stt" || \result.kind === "RelayRefused"
  //@ ensures \result.kind === "Stt" ==> utf16Units(\result.transcript) <= maxTranscriptChars
  const event = fieldOf(f, "event")
  if (f.length !== 2 || event.kind !== "JsonObject") return { kind: "RelayRefused" }
  const kind = sttKindOf(fieldOf(event.fields, "type"))
  if (kind === 0) return event.fields.length === 1 ? { kind: "Stt", event: "SttConnected", transcript: [] } : { kind: "RelayRefused" }
  const transcript = fieldOf(event.fields, "transcript")
  if (kind < 0 || event.fields.length !== 2 || transcript.kind !== "JsonText" || utf16Units(transcript.bytes) > maxTranscriptChars) return { kind: "RelayRefused" }
  const events: SttEventKind[] = ["SttConnected", "StartOfTurn", "TurnResumed", "EndOfTurn", "TranscriptUpdate", "EagerEndOfTurn"]
  return { kind: "Stt", event: events[kind], transcript: transcript.bytes }
}

function readFailure(f: JsonField[]): RelayWire {
  //@ ensures \result.kind === "Failed" || \result.kind === "RelayRefused"
  const code = errorCodeOfWire(fieldOf(f, "code"))
  const reason = fieldOf(f, "reason")
  if (code < 0 || !onlyKeys(f, ["t", "code", "reason"])) return { kind: "RelayRefused" }
  const codes: RelayErrorCode[] = ["RelayUnauthorized", "RelayProtocol", "RelayUnavailable", "RelayClosed"]
  if (reason.kind === "JsonAbsent") return { kind: "Failed", code: codes[code], reason: { tag: "NoRelayReason" } }
  if (textIs(reason, "insufficient_credits")) return { kind: "Failed", code: codes[code], reason: { tag: "FundingReason", funding: "CreditsShort" } }
  if (textIs(reason, "allowance_exhausted")) return { kind: "Failed", code: codes[code], reason: { tag: "FundingReason", funding: "AllowanceShort" } }
  return { kind: "RelayRefused" }
}

export function readRelay(b: number[], binary: boolean): RelayWire {
  //@ ensures binary ==> \result === readAudio(b)
  //@ ensures \result.kind === "Audio" ==> idBytesValid(\result.id) && validPcm(\result.pcm.length, maxDownlinkPcmBytes)
  //@ ensures (\result.kind === "Prepared" || \result.kind === "Flushed" || \result.kind === "Completed") ==> idBytesValid(\result.id)
  //@ ensures \result.kind === "Stt" ==> utf16Units(\result.transcript) <= maxTranscriptChars
  if (binary) return readAudio(b)
  if (!utf8Valid(b)) return { kind: "RelayRefused" }
  const json = readJson(b, 1)
  if (!json.ok) return { kind: "RelayRefused" }
  const f = json.fields
  const t = fieldOf(f, "t")
  if (textIs(t, "stt")) return readStt(f)
  if (textIs(t, "error")) return readFailure(f)
  const expiresAt = fieldOf(f, "expiresAt")
  if (textIs(t, "ready")) {
    const version = fieldOf(f, "version")
    const sampleRate = fieldOf(f, "sampleRate")
    const channels = fieldOf(f, "channels")
    if (f.length !== 5 || expiresAt.kind !== "JsonText" || version.kind !== "JsonCount" || version.n !== relayVersion || sampleRate.kind !== "JsonCount" || sampleRate.n !== relaySampleRate || channels.kind !== "JsonCount" || channels.n !== relayChannels) return { kind: "RelayRefused" }
    return { kind: "Ready", expiresAt: expiresAt.bytes }
  }
  if (textIs(t, "extended")) return f.length === 2 && expiresAt.kind === "JsonText" ? { kind: "Extended", expiresAt: expiresAt.bytes } : { kind: "RelayRefused" }
  const id = idValue(fieldOf(f, "id"))
  if (f.length !== 2 || !idBytesValid(id)) return { kind: "RelayRefused" }
  if (textIs(t, "tts_prepared")) return { kind: "Prepared", id: id }
  if (textIs(t, "flush_complete")) return { kind: "Flushed", id: id }
  if (textIs(t, "complete")) return { kind: "Completed", id: id }
  return { kind: "RelayRefused" }
}

//@ pure
function hexOf(n: number): number {
  //@ requires 0 <= n && n < 16
  return n < 10 ? 48 + n : 87 + n
}

function quoted(bytes: number[]): number[] {
  let out: number[] = [34]
  let i = 0
  while (i < bytes.length) {
    //@ invariant 0 <= i && i <= bytes.length
    //@ decreases bytes.length - i
    const c = bytes[i]
    if (c === 34 || c === 92) out = out.concat([92, c])
    else if (c === 8) out = out.concat([92, 98])
    else if (c === 9) out = out.concat([92, 116])
    else if (c === 10) out = out.concat([92, 110])
    else if (c === 12) out = out.concat([92, 102])
    else if (c === 13) out = out.concat([92, 114])
    else if (c >= 0 && c < 32) out = out.concat([92, 117, 48, 48, hexOf(Math.floor(c / 16)), hexOf(c % 16)])
    else out.push(c)
    i = i + 1
  }
  out.push(34)
  return out
}

function decimal(n: number): number[] {
  //@ requires n >= 0
  if (n === 0) return [48]
  let digits: number[] = []
  let rest = n
  while (rest > 0) {
    //@ invariant rest >= 0
    //@ decreases rest
    digits = [48 + rest % 10].concat(digits)
    rest = Math.floor(rest / 10)
  }
  return digits
}

function member(key: string, value: number[]): number[] {
  return quoted(ascii(key)).concat([58]).concat(value)
}

function object(members: number[][]): number[] {
  let out: number[] = [123]
  let i = 0
  while (i < members.length) {
    //@ invariant 0 <= i && i <= members.length
    //@ decreases members.length - i
    if (i > 0) out.push(44)
    out = out.concat(members[i])
    i = i + 1
  }
  out.push(125)
  return out
}

function typed(t: string, members: number[][]): number[] {
  return object([member("t", quoted(ascii(t)))].concat(members))
}

function control(bytes: number[]): Written {
  //@ ensures \result.kind === "Written" ==> \result.bytes.length <= maxControlBytes
  return bytes.length <= maxControlBytes ? { kind: "Written", bytes: bytes } : { kind: "Unwritable" }
}

export function writeDevice(f: DeviceWire): Written {
  //@ ensures (\result.kind === "Written" && f.kind !== "Uplink") ==> \result.bytes.length <= maxControlBytes
  //@ ensures (f.kind === "Uplink" && validUplink(f.pcm.length)) ==> (\result.kind === "Written" && \result.bytes === f.pcm)
  if (f.kind === "Uplink") return validUplink(f.pcm.length) ? { kind: "Written", bytes: f.pcm } : { kind: "Unwritable" }
  if (f.kind === "DeviceRefused") return { kind: "Unwritable" }
  if (f.kind === "Stop") return control(typed("stop", []))
  if (f.kind === "Hello") {
    if (!validHelloToken(utf16Units(f.token)) || !utf8Valid(f.token)) return { kind: "Unwritable" }
    const reasons: number[][] = f.errorReasons ? [member("errorReasons", ascii("true"))] : []
    const extend: number[][] = f.extend ? [member("extend", ascii("true"))] : []
    return control(typed("hello", [member("token", quoted(f.token))].concat(reasons).concat(extend)))
  }
  if (!idBytesValid(f.id)) return { kind: "Unwritable" }
  if (f.kind === "Prepare") return control(typed("prepare", [member("id", quoted(f.id))]))
  if (f.kind === "Finish") return control(typed("finish", [member("id", quoted(f.id))]))
  if (f.kind === "Cancel") return control(typed("cancel", [member("id", quoted(f.id))]))
  const units = utf16Units(f.text)
  if (units > maxTtsTextChars || !validTtsText(units, blankText(f.text)) || !utf8Valid(f.text)) return { kind: "Unwritable" }
  const flush: number[][] = f.flush ? [member("flush", ascii("true"))] : []
  return control(typed("tts", [member("id", quoted(f.id)), member("text", quoted(f.text))].concat(flush)))
}

//@ pure
function sttWire(e: SttEventKind): string {
  switch (e) {
    case "SttConnected": return "connected"
    case "StartOfTurn": return "start-of-turn"
    case "TurnResumed": return "turn-resumed"
    case "EndOfTurn": return "end-of-turn"
    case "TranscriptUpdate": return "transcript-update"
    case "EagerEndOfTurn": return "eager-end-of-turn"
  }
}

//@ pure
function errorWire(c: RelayErrorCode): string {
  switch (c) {
    case "RelayUnauthorized": return "unauthorized"
    case "RelayProtocol": return "protocol"
    case "RelayUnavailable": return "unavailable"
    case "RelayClosed": return "closed"
  }
}

function reasonMembers(r: RelayReason): number[][] {
  if (r.tag === "NoRelayReason") return []
  return [member("reason", quoted(ascii(r.funding === "CreditsShort" ? "insufficient_credits" : "allowance_exhausted")))]
}

export function writeRelay(f: RelayWire): Written {
  //@ ensures (f.kind === "Audio" && \result.kind === "Written") ==> audioFrameFits(\result.bytes) && \result.bytes === encodeAudio(f.id, f.pcm)
  //@ ensures (f.kind === "Audio" && idBytesValid(f.id) && validPcm(f.pcm.length, maxDownlinkPcmBytes)) ==> \result.kind === "Written"
  switch (f.kind) {
    case "Audio": return idBytesValid(f.id) && validPcm(f.pcm.length, maxDownlinkPcmBytes) ? { kind: "Written", bytes: encodeAudio(f.id, f.pcm) } : { kind: "Unwritable" }
    case "RelayRefused": return { kind: "Unwritable" }
    case "Ready":
      if (!utf8Valid(f.expiresAt)) return { kind: "Unwritable" }
      return { kind: "Written", bytes: typed("ready", [member("version", decimal(relayVersion)), member("sampleRate", decimal(relaySampleRate)), member("channels", decimal(relayChannels)), member("expiresAt", quoted(f.expiresAt))]) }
    case "Extended":
      if (!utf8Valid(f.expiresAt)) return { kind: "Unwritable" }
      return { kind: "Written", bytes: typed("extended", [member("expiresAt", quoted(f.expiresAt))]) }
    case "Stt":
      if (f.event === "SttConnected") return { kind: "Written", bytes: typed("stt", [member("event", object([member("type", quoted(ascii("connected")))]))]) }
      if (!utf8Valid(f.transcript) || utf16Units(f.transcript) > maxTranscriptChars) return { kind: "Unwritable" }
      return { kind: "Written", bytes: typed("stt", [member("event", object([member("type", quoted(ascii(sttWire(f.event)))), member("transcript", quoted(f.transcript))]))]) }
    case "Failed": return { kind: "Written", bytes: typed("error", [member("code", quoted(ascii(errorWire(f.code))))].concat(reasonMembers(f.reason))) }
    case "Prepared": return idBytesValid(f.id) ? { kind: "Written", bytes: typed("tts_prepared", [member("id", quoted(f.id))]) } : { kind: "Unwritable" }
    case "Flushed": return idBytesValid(f.id) ? { kind: "Written", bytes: typed("flush_complete", [member("id", quoted(f.id))]) } : { kind: "Unwritable" }
    case "Completed": return idBytesValid(f.id) ? { kind: "Written", bytes: typed("complete", [member("id", quoted(f.id))]) } : { kind: "Unwritable" }
  }
}
