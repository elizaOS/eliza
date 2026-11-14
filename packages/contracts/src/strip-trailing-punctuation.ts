//@ option string-semantics javascript-utf16
//@ option dafny-library local
/** Removes only the final run of the supplied UTF-16 punctuation characters. */
export function stripTrailingPunctuation(
  text: string,
  punctuation: string,
): string {
  //@ verify
  //@ ensures \result.length <= text.length
  //@ ensures \result === text.slice(0, \result.length)
  //@ ensures \result.length === 0 || !punctuation.includes(\result.slice(\result.length - 1, \result.length))
  //@ ensures forall(i: int, \result.length <= i && i < text.length ==> punctuation.includes(text.slice(i, i + 1)))
  let end = text.length;
  while (end > 0 && punctuation.includes(text.slice(end - 1, end))) {
    //@ invariant 0 <= end && end <= text.length
    //@ invariant forall(i: int, end <= i && i < text.length ==> punctuation.includes(text.slice(i, i + 1)))
    //@ decreases end
    end--;
  }
  //@ assert end === 0 || !punctuation.includes(text.slice(end - 1, end))
  //@ assert end === 0 || text.slice(0, end).slice(end - 1, end) === text.slice(end - 1, end)
  return text.slice(0, end);
}
