/**
 * Surrogate-safe text helpers for service diagnostics (leaf-local copy
 * to avoid pulling @elizaos/core into the webhook Docker bundle).
 * Well-formed truncation prevents lone-surrogate \uD8xx escapes and
 * split emoji in provider error diagnostics.
 */
const HIGH_START = 0xd800, HIGH_END = 0xdbff, LOW_START = 0xdc00, LOW_END = 0xdfff;
const REPLACEMENT = "�";
function isHigh(c: number){ return c>=HIGH_START && c<=HIGH_END; }
function isLow(c: number){ return c>=LOW_START && c<=LOW_END; }
function replaceLone(text: string){
  let out=""; for(let i=0;i<text.length;i++){ const cc=text.charCodeAt(i); if(isHigh(cc)){ if(i+1<text.length && isLow(text.charCodeAt(i+1))){ out+=text[i]!+text[i+1]!; i++; } else out+=REPLACEMENT; } else if(isLow(cc)) out+=REPLACEMENT; else out+=text[i]!; } return out;
}
export function toWellFormedUnicode(text: string): string {
  const n = (String.prototype as {toWellFormed?:(this:string)=>string}).toWellFormed;
  if(n) return n.call(text);
  const w=(String.prototype as {isWellFormed?:(this:string)=>boolean}).isWellFormed;
  if(w?.call(text)) return text;
  return replaceLone(text);
}
export function truncateWellFormed(text: string, max: number): string {
  if(!Number.isFinite(max)||max<=0) return "";
  if(text.length<=max) return text;
  const end=isHigh(text.charCodeAt(max-1)) && isLow(text.charCodeAt(max)) ? max-1 : max;
  return text.slice(0,end);
}
