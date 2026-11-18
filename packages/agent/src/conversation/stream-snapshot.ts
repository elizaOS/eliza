//@ backend dafny
// spec/agent/conversation/replyStream.md, "Story: See a reply as it is written"

export interface Cadence { appended: number; lastLength: number }

export interface Appended { cadence: Cadence; snapshot: boolean }

export const snapshotFloor = 2048;

export const start: Cadence = { appended: 0, lastLength: 0 };

//@ pure
export function due(lastLength: number): number {
  //@ ensures \result >= 2048 && \result >= lastLength
  //@ ensures \result === 2048 || \result === lastLength
  return lastLength > snapshotFloor ? lastLength : snapshotFloor;
}

//@ pure
export function steady(c: Cadence): boolean {
  return c.appended >= 0 && c.lastLength >= 0 && c.appended < due(c.lastLength);
}

//@ pure
export function fullLength(c: Cadence): number {
  return c.lastLength + c.appended;
}

//@ pure
export function append(c: Cadence, units: number): Appended {
  //@ requires steady(c) && units >= 0
  //@ ensures steady(\result.cadence)
  //@ ensures fullLength(\result.cadence) === fullLength(c) + units
  //@ ensures \result.snapshot === (c.appended + units >= due(c.lastLength))
  //@ ensures \result.snapshot ==> \result.cadence.appended === 0 && \result.cadence.lastLength <= 2 * (c.appended + units)
  //@ ensures !\result.snapshot ==> \result.cadence.lastLength === c.lastLength
  const pending = c.appended + units;
  if (pending >= due(c.lastLength)) {
    return { cadence: { appended: 0, lastLength: c.lastLength + pending }, snapshot: true };
  }
  return { cadence: { appended: pending, lastLength: c.lastLength }, snapshot: false };
}

//@ pure
export function replace(length: number): Cadence {
  //@ requires length >= 0
  //@ ensures steady(\result) && fullLength(\result) === length
  return { appended: 0, lastLength: length };
}
