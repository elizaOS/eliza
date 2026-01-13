import { writeLocalStorageString } from "../utils/localStorage";

type ProcessEnv = Record<string, string | undefined>;
type ProcessShim = { env: ProcessEnv };

declare global {
  // eslint-disable-next-line no-var
  var process: ProcessShim | undefined;
}

function ensureSecretSalt(env: ProcessEnv): void {
  if (env.SECRET_SALT && env.SECRET_SALT.trim()) return;
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(salt)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    env.SECRET_SALT = hex;
    writeLocalStorageString("eliza-vrm-demo:SECRET_SALT", hex);
  } catch {
    env.SECRET_SALT = "secretsalt";
  }
}

export function ensureProcessShim(): void {
  const g = globalThis as typeof globalThis & { process?: ProcessShim };
  if (!g.process) {
    g.process = { env: {} };
  }
  ensureSecretSalt(g.process.env);
}

ensureProcessShim();

type ProcessLike = {
  env: Record<string, string | undefined>;
};

const g = globalThis as typeof globalThis & {
  process?: ProcessLike;
};

if (!g.process) {
  g.process = { env: {} };
} else if (!g.process.env) {
  g.process.env = {};
}

