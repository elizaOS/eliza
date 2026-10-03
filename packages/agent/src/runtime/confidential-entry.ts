/**
 * Runs the fixed confidential agent from a digest-bound configuration document.
 * Only Node builtins load before the document is checked. The measured outer
 * bootstrap must authenticate the environment containing its path and digest;
 * this entry adds no ingress, storage-encryption or network-isolation claim.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Verifies complete bytes before parsing or importing the application runtime. */
export async function loadConfidentialRuntimeDocument(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  const path = environment.ELIZA_CONFIDENTIAL_RUNTIME_CONFIG;
  const digest = environment.ELIZA_CONFIDENTIAL_RUNTIME_CONFIG_SHA256;
  if (!path || !isAbsolute(path) || !digest || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Confidential process configuration rejected");
  }
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("Confidential process configuration rejected");
  }
  return JSON.parse(bytes.toString("utf8"));
}

/** Owns runtime shutdown; callers must launch through the measured bootstrap. */
export async function runConfidentialProcess(): Promise<void> {
  const environment = Object.freeze({ ...process.env });
  let stopRequested = false;
  let requestStop: () => void = () => {
    stopRequested = true;
  };
  const stopped = new Promise<void>((resolveStopped) => {
    requestStop = () => {
      stopRequested = true;
      resolveStopped();
    };
  });
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  // This headless process must remain supervised even if every runtime service
  // unrefs its timers. The timer has no readiness or telemetry semantics.
  const lifetime = setInterval(() => {}, 1_073_741_824);
  try {
    const document = await loadConfidentialRuntimeDocument(environment);
    if (stopRequested) return;
    const { confidentialRuntimeConfiguration, startConfidentialRuntime } =
      await import("./confidential-runtime.ts");
    const configuration = confidentialRuntimeConfiguration.parse(document);
    if (stopRequested) return;
    const started = await startConfidentialRuntime(configuration, environment);
    try {
      await stopped;
    } finally {
      await started.stop();
    }
  } finally {
    clearInterval(lifetime);
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runConfidentialProcess();
  } catch {
    // error-policy:J1 The pre-import boundary cannot load a logger or expose configuration.
    process.stderr.write(
      "Confidential agent process startup or shutdown failed.\n",
    );
    process.exitCode = 1;
  }
}
