function resolveIteratee(iteratee) {
  if (typeof iteratee === "function") return iteratee;
  return (value) => value?.[iteratee];
}

export default function sumBy(collection, iteratee) {
  if (collection == null) return 0;
  const selector = resolveIteratee(iteratee);
  let total = 0;
  for (const item of collection) {
    total += Number(selector(item)) || 0;
  }
  return total;
}
