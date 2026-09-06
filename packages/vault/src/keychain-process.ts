/**
 * Isolates native Keychain operations behind a bounded child-process boundary.
 * Key material travels only through a private pipe; failures never include child
 * output. A blocked OS prompt cannot indefinitely stall a synchronous caller.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TIMEOUT_MS = 5_000;

// The child owns the complete read/create/verify operation. In particular, a
// failed read must never be interpreted as an absent key and overwrite it.
const WORKER = `
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
const [binding, service, account] = process.argv.slice(1);
let phase = "binding";
try {
  const { Entry } = createRequire(binding)(binding);
  const entry = new Entry(service, account);
  phase = "read";
  let encoded = entry.getPassword();
  if (encoded === null || encoded === "") {
    encoded = randomBytes(32).toString("base64");
    phase = "write";
    entry.setPassword(encoded);
    phase = "verify";
    if (entry.getPassword() !== encoded) throw new Error("read-back mismatch");
  }
  if (typeof encoded !== "string" || Buffer.from(encoded, "base64").length !== 32 ||
      Buffer.from(encoded, "base64").toString("base64") !== encoded) {
    phase = "invalid-key";
    throw new Error("invalid key");
  }
  process.stdout.write(JSON.stringify({ key: encoded }));
} catch {
  process.stdout.write(JSON.stringify({ error: phase }));
  process.exitCode = 1;
}
`;

export interface KeychainProcessOptions {
  /** The native binding path; injectable for real subprocess contract tests. */
  binding?: string;
  timeoutMs?: number;
}

function argumentsFor(service: string, account: string, binding?: string) {
  return [
    "--input-type=module",
    "--eval",
    WORKER,
    binding ?? require.resolve("@napi-rs/keyring"),
    service,
    account,
  ];
}

function unavailable(): Error {
  return new Error(
    "OS Keychain did not complete a verified key read within its deadline. Unlock the login Keychain and approve the app's existing Keychain access, then retry. No replacement key was returned.",
  );
}

function decode(output: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // error-policy:J3 Only the fixed, validated key protocol may cross the pipe.
    throw unavailable();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("key" in parsed) ||
    typeof parsed.key !== "string" ||
    Buffer.from(parsed.key, "base64").length !== 32 ||
    Buffer.from(parsed.key, "base64").toString("base64") !== parsed.key
  ) {
    throw unavailable();
  }
  return Buffer.from(parsed.key, "base64");
}

export function readKeychainKeySync(
  service: string,
  account: string,
  options: KeychainProcessOptions = {},
): Buffer {
  const result = spawnSync(
    process.execPath,
    argumentsFor(service, account, options.binding),
    {
      encoding: "utf8",
      timeout: options.timeoutMs ?? TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) throw unavailable();
  return decode(result.stdout);
}
