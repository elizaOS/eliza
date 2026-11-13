/** Proof uses integer Number counters; runtime equivalence requires finite safe
 * integers and safe index * size multiplication. No runtime bounds are added. */
export function speechWindowShare(
  total: number,
  size: number,
  index: number,
  granted: number,
): number {
  //@ verify
  //@ pure
  //@ requires 0 <= total && total <= 9007199254740991
  //@ requires 0 < size && size <= 9007199254740991
  //@ requires 0 <= index && index < granted
  //@ requires granted <= 9007199254740991 && granted * size <= 9007199254740991
  //@ ensures 0 <= \result
  //@ ensures index < granted - 1 ==> \result <= size
  //@ ensures index === granted - 1 ==> \result === Math.max(0, total - index * size)
  const remainder = Math.max(0, total - index * size);
  return index === granted - 1 ? remainder : Math.min(size, remainder);
}
