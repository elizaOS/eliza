import { execFile } from "node:child_process";

export interface BackendAvailability {
  mlx: boolean;
  cuda: boolean;
  cpu: boolean;
}

let cached: { result: BackendAvailability; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

function probe(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: 3_000 }, (err) => {
      resolve(!err);
    });
    child.stdin?.end();
  });
}

export async function detectAvailableBackends(): Promise<BackendAvailability> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  const [mlx, cuda] = await Promise.all([
    process.platform === "darwin"
      ? probe("python3", ["-c", "import mlx"])
      : Promise.resolve(false),
    probe("nvidia-smi", []),
  ]);

  const result: BackendAvailability = { mlx, cuda, cpu: true };
  cached = { result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}

export function clearBackendCache(): void {
  cached = null;
}
