function resolveIteratee(iteratee) {
  if (typeof iteratee === "function") return iteratee;
  return (value) => value?.[iteratee];
}

export default function uniqBy(collection, iteratee) {
  if (collection == null) return [];
  const selector = resolveIteratee(iteratee);
  const seen = new Set();
  const result = [];
  for (const item of collection) {
    const key = selector(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
