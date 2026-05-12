import { writeLocalStorageString } from "../utils/localStorage";

type ProcessEnv = Record<string, string | undefined>;
type ProcessShim = { env: ProcessEnv };

function isProcessShim(value: unknown): value is ProcessShim {
  return (
    !!value &&
    typeof value === "object" &&
    !!Reflect.get(value, "env") &&
    typeof Reflect.get(value, "env") === "object"
  );
}

function readProcessShim(): ProcessShim | undefined {
  const candidate: unknown = Reflect.get(globalThis, "process");
  return isProcessShim(candidate) ? candidate : undefined;
}

function writeProcessShim(processShim: ProcessShim): void {
  Reflect.set(globalThis, "process", processShim);
}

function ensureSecretSalt(env: ProcessEnv): void {
  if (env.SECRET_SALT?.trim()) return;
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
  const current = readProcessShim();
  if (!current) {
    const processShim: ProcessShim = { env: {} };
    writeProcessShim(processShim);
    ensureSecretSalt(processShim.env);
    return;
  }
  ensureSecretSalt(current.env);
}

ensureProcessShim();

const processShim = readProcessShim();
if (!processShim) {
  writeProcessShim({ env: {} });
}
