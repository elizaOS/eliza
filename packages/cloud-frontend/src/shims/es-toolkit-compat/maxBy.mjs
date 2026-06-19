function resolveIteratee(iteratee) {
  if (typeof iteratee === "function") return iteratee;
  return (value) => value?.[iteratee];
}

export default function maxBy(collection, iteratee) {
  if (collection == null) return undefined;
  const selector = resolveIteratee(iteratee);
  let result;
  let maxValue;
  for (const item of collection) {
    const current = selector(item);
    if (current == null) continue;
    if (result === undefined || current > maxValue) {
      result = item;
      maxValue = current;
    }
  }
  return result;
}
