/** Resolve host discovery paths once while preserving candidate order. */
import path from "node:path";
export function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}
