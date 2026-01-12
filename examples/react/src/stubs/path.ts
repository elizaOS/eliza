/**
 * Browser stub for Node.js 'path' module.
 * Provides minimal path utilities for browser environments.
 */

export function join(...paths: string[]): string {
  return paths
    .map((part, i) => {
      if (i === 0) {
        return part.replace(/\/*$/, "");
      }
      return part.replace(/^\/*/, "").replace(/\/*$/, "");
    })
    .filter((x) => x.length)
    .join("/");
}

export function dirname(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

export function basename(path: string, ext?: string): string {
  let base = path.split("/").pop() ?? "";
  if (ext && base.endsWith(ext)) {
    base = base.slice(0, -ext.length);
  }
  return base;
}

export function extname(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf(".");
  return idx === -1 ? "" : base.slice(idx);
}

export function resolve(...paths: string[]): string {
  return `/${join(...paths)}`;
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

export function normalize(path: string): string {
  const parts = path.split("/");
  const result: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      result.pop();
    } else if (part !== "." && part !== "") {
      result.push(part);
    }
  }
  return (path.startsWith("/") ? "/" : "") + result.join("/");
}

export const sep = "/";
export const delimiter = ":";

export default {
  join,
  dirname,
  basename,
  extname,
  resolve,
  isAbsolute,
  normalize,
  sep,
  delimiter,
};
