export function expandTildePath(filepath: string): string {
  return filepath;
}

export function resolveEnvFile(_startDir?: string): string {
  return ".env";
}

export function resolvePgliteDir(_dir?: string, _fallbackDir?: string): string {
  return "in-memory";
}
