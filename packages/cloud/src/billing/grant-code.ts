//@ backend dafny
// spec/cloud/billing/grantCodes.md, "A code is 16 Crockford base32 characters, read without case, spaces or hyphens, with I and L read as 1 and O as 0"
import { grantCodeLength } from "../../gen/cloud__billing__grantCodes.ts"

//@ pure
export function isCrockford(unit: number): boolean {
  return (unit >= 48 && unit <= 57) || (unit >= 65 && unit <= 90 && unit !== 73 && unit !== 76 && unit !== 79 && unit !== 85)
}

//@ pure
export function isSeparator(unit: number): boolean {
  return unit === 32 || unit === 45 || (unit >= 9 && unit <= 13)
}

//@ pure
export function readUnit(unit: number): number {
  //@ ensures \result === -1 || isCrockford(\result)
  const upper = unit >= 97 && unit <= 122 ? unit - 32 : unit
  if (upper === 73 || upper === 76) return 49
  if (upper === 79) return 48
  return isCrockford(upper) ? upper : -1
}

//@ pure
export function allCrockford(code: string): boolean {
  //@ decreases code.length
  if (code.length === 0) return true
  return isCrockford(code.charCodeAt(0)) && allCrockford(code.slice(1))
}

//@ pure
export function readable(text: string): boolean {
  //@ decreases text.length
  if (text.length === 0) return true
  const unit = text.charCodeAt(0)
  return (isSeparator(unit) || readUnit(unit) !== -1) && readable(text.slice(1))
}

//@ pure
export function canonical(text: string): string {
  //@ decreases text.length
  //@ ensures allCrockford(\result)
  if (text.length === 0) return ""
  const unit = text.charCodeAt(0)
  const rest = canonical(text.slice(1))
  const read = readUnit(unit)
  if (isSeparator(unit) || read === -1) return rest
  const code = String.fromCharCode(read) + rest
  //@ assert code.slice(1) === rest
  return code
}

//@ pure
export function normalizeSubscriptionCode(text: string): string {
  //@ ensures allCrockford(\result)
  //@ ensures \result.length === grantCodeLength || \result.length === 0
  //@ ensures (readable(text) && canonical(text).length === grantCodeLength) ==> \result === canonical(text)
  //@ ensures !(readable(text) && canonical(text).length === grantCodeLength) ==> \result.length === 0
  const code = canonical(text)
  return readable(text) && code.length === grantCodeLength ? code : ""
}
