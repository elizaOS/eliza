function toPath(path) {
  if (Array.isArray(path)) return path;
  if (typeof path !== "string") return [path];
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

export default function get(object, path, defaultValue) {
  let value = object;
  for (const key of toPath(path)) {
    if (value == null) return defaultValue;
    value = value[key];
  }
  return value === undefined ? defaultValue : value;
}
