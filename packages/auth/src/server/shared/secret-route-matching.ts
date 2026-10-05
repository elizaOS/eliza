/** Shared credential-route matching and intersection semantics. */
export function matchSecretRouteHost(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return false;
}

export function matchSecretRoutePath(pattern: string, path: string): boolean {
  if (pattern === "/*" || pattern === "*") return true;
  if (pattern === path) return true;
  if (pattern.endsWith("/*")) return path.startsWith(pattern.slice(0, -1));
  return false;
}

export function secretRouteHostPatternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith("*.")) {
    const witness = b.startsWith("*.") ? `x${b.slice(1)}` : b;
    if (matchSecretRouteHost(a, witness)) return true;
  }
  if (b.startsWith("*.")) {
    const witness = a.startsWith("*.") ? `x${a.slice(1)}` : a;
    if (matchSecretRouteHost(b, witness)) return true;
  }
  return false;
}

export function secretRoutePathPatternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const witness = (pattern: string) => {
    if (pattern === "*" || pattern === "/*")
      return "/__steward_overlap_witness__";
    if (pattern.endsWith("/*"))
      return `${pattern.slice(0, -1)}__steward_overlap_witness__`;
    return pattern;
  };
  return (
    matchSecretRoutePath(a, witness(b)) || matchSecretRoutePath(b, witness(a))
  );
}

export function secretRouteMethodPatternsOverlap(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = (a ?? "*").toUpperCase();
  const right = (b ?? "*").toUpperCase();
  return left === "*" || right === "*" || left === right;
}
