function resolveIteratee(iteratee) {
  if (typeof iteratee === "function") return iteratee;
  return (value) => value?.[iteratee];
}

export default function sortBy(collection, iteratees) {
  if (collection == null) return [];
  const selectors = (Array.isArray(iteratees) ? iteratees : [iteratees]).map(
    resolveIteratee,
  );
  return [...collection].sort((left, right) => {
    for (const selector of selectors) {
      const a = selector(left);
      const b = selector(right);
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  });
}
