/**
 * Matches host plugin routes for dispatch, lazy loading and route admission.
 * Empty slash segments are ignored; named parameters and nonempty wildcard
 * tails are decoded once, preserving raw parameter text for malformed escapes.
 * The matcher has no runtime imports so lazy route gates stay cheap.
 */

export function matchPluginRoutePath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const norm = (p: string) => p.split("/").filter((s) => s.length > 0);
  const pSegs = norm(pattern);
  const pathSegs = norm(pathname);
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i];
    const c = pathSegs[i];
    if (!p) return null;
    if (p.startsWith(":") && p.endsWith("*")) {
      const key = p.slice(1, -1);
      const tail = pathSegs.slice(i).join("/");
      if (!tail) return null;
      try {
        params[key] = decodeURIComponent(tail);
      } catch {
        // error-policy:J1 Preserve raw route parameters when URI decoding fails.
        params[key] = tail;
      }
      return params;
    }
    if (c === undefined) return null;
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(c);
      } catch {
        // error-policy:J1 Preserve raw route parameters when URI decoding fails.
        params[p.slice(1)] = c;
      }
    } else if (p !== c) {
      return null;
    }
  }
  return pSegs.length === pathSegs.length ? params : null;
}
