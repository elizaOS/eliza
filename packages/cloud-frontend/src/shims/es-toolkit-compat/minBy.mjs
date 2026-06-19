function resolveIteratee(iteratee) {
  if (typeof iteratee === "function") return iteratee;
  return (value) => value?.[iteratee];
}

export default function minBy(collection, iteratee) {
  if (collection == null) return undefined;
  const selector = resolveIteratee(iteratee);
  let result;
  let minValue;
  for (const item of collection) {
    const current = selector(item);
    if (current == null) continue;
    if (result === undefined || current < minValue) {
      result = item;
      minValue = current;
    }
  }
  return result;
}
