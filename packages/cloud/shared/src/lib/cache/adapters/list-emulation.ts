/**
 * Redis list semantics for the adapters that emulate lists over plain values
 * (in-memory, Cloudflare KV). `rangeOf` follows LRANGE: negative offsets count
 * from the tail and `stop` is inclusive. `removeOccurrences` follows LREM:
 * a positive `count` removes from the head, a negative one from the tail and
 * zero removes every occurrence. Both mutate nothing but the list they return.
 */

export function rangeOf(list: readonly string[], start: number, stop: number): string[] {
  const length = list.length;
  const from = start < 0 ? Math.max(length + start, 0) : start;
  const to = stop < 0 ? length + stop : Math.min(stop, length - 1);
  if (from > to || from >= length) return [];
  return list.slice(from, to + 1);
}

export function removeOccurrences(list: string[], count: number, value: string): number {
  let removed = 0;
  const limit = count === 0 ? Number.POSITIVE_INFINITY : Math.abs(count);
  if (count < 0) {
    for (let index = list.length - 1; index >= 0 && removed < limit; index--) {
      if (list[index] === value) {
        list.splice(index, 1);
        removed++;
      }
    }
    return removed;
  }
  for (let index = 0; index < list.length && removed < limit; ) {
    if (list[index] === value) {
      list.splice(index, 1);
      removed++;
    } else {
      index++;
    }
  }
  return removed;
}
