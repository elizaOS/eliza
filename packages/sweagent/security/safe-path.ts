import path from "node:path";

/** GHSA-jvqc-qp6c-g58f / GHSA-w846-hghr-xmrc — path traversal outside trajectory root. */
export function resolvePathWithinRoot(
  rootDir: string,
  userPath: string,
): string {
  if (userPath.includes("\0")) {
    throw new Error("Invalid path");
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, userPath);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Invalid path");
  }
  return resolved;
}
