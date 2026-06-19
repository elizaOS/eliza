export default function omit(object, paths) {
  if (object == null) return {};
  const excluded = new Set(Array.isArray(paths) ? paths : [paths]);
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !excluded.has(key)),
  );
}
