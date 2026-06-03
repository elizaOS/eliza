// Stub for `node:path` in the Storybook browser catalog. Vite externalizes
// node builtins, so accessing `path.isAbsolute`/`join`/`resolve` (called by
// @elizaos/core/utils/state-dir at load) throws. These are pure string
// operations, so the stub provides working posix implementations instead of
// throwing — derived paths stay correct enough for module init.

export const sep = "/";
export const delimiter = ":";

const normalizeArray = (parts: string[], allowAboveRoot: boolean) => {
  const res: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (res.length && res[res.length - 1] !== "..") res.pop();
      else if (allowAboveRoot) res.push("..");
    } else {
      res.push(p);
    }
  }
  return res;
};

export const isAbsolute = (p: string) => p.startsWith("/");

export const normalize = (p: string) => {
  if (!p) return ".";
  const absolute = isAbsolute(p);
  const trailing = p.endsWith("/");
  let out = normalizeArray(p.split("/"), !absolute).join("/");
  if (!out && !absolute) out = ".";
  if (out && trailing) out += "/";
  return (absolute ? "/" : "") + out;
};

export const join = (...parts: string[]) => {
  const joined = parts
    .filter((p) => typeof p === "string" && p.length)
    .join("/");
  return joined ? normalize(joined) : ".";
};

export const resolve = (...parts: string[]) => {
  let resolved = "";
  let absolute = false;
  for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
    const p = parts[i];
    if (!p) continue;
    resolved = `${p}/${resolved}`;
    absolute = isAbsolute(p);
  }
  resolved = normalizeArray(resolved.split("/"), !absolute).join("/");
  if (absolute) return `/${resolved}`;
  return resolved.length ? resolved : ".";
};

export const dirname = (p: string) => {
  if (!p) return ".";
  const parts = p.replace(/\/+$/, "").split("/");
  parts.pop();
  const d = parts.join("/");
  return d || (isAbsolute(p) ? "/" : ".");
};

export const basename = (p: string, ext?: string) => {
  const base = p.replace(/\/+$/, "").split("/").pop() ?? "";
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
};

export const extname = (p: string) => {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
};

export const relative = (from: string, to: string) => {
  const f = resolve(from).split("/").filter(Boolean);
  const t = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...f.slice(i).map(() => ".."), ...t.slice(i)].join("/") || ".";
};

export const parse = (p: string) => {
  const dir = dirname(p);
  const base = basename(p);
  const ext = extname(p);
  return {
    root: isAbsolute(p) ? "/" : "",
    dir,
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
};

export const posix = {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  parse,
};

export default {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  parse,
  posix,
};
