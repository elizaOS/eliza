import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ElizaError } from "@elizaos/core";
import { isAndroidMobile, resolveApiToken } from "@elizaos/host/protocol";

const brokerKeys = [
  "ELIZA_MANAGED_GMAIL_READ_BROKER",
  "ELIZA_MANAGED_GMAIL_SEND_BROKER",
  "ELIZA_MANAGED_GMAIL_OPERATION_BROKER",
  "ELIZA_MANAGED_CALENDAR_READ_BROKER",
] as const;
/**
 * Gmail sending through the native host depends on a separately owned
 * production service that is not yet qualified on device. The host publishes
 * the send endpoint only when this flag is explicitly set; the owner must still
 * review each exact draft before dispatch.
 */
export const NATIVE_GMAIL_SEND_FLAG = "ELIZA_NATIVE_GOOGLE_GMAIL_SEND_ENABLED";
const enabled = (value: string | undefined) => {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
};
const unavailable = (message: string) =>
  new ElizaError(message, { code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" });

/** Load one explicitly admitted application host module, not a discovered plugin. */
export async function startNativeManagedGoogleHost(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ close(): Promise<void> } | undefined> {
  const prepareCloud = isAndroidMobile(env) && enabled(env.ELIZAOS_CLOUD_USE_INFERENCE);
  const entry = env.ELIZA_NATIVE_GOOGLE_HOST_MODULE;
  if (!entry) {
    if (prepareCloud) throw new ElizaError("Native Cloud routing module is unavailable", {code:"NATIVE_CLOUD_ROUTING_UNAVAILABLE"});
    return;
  }
  const root = env.ELIZA_SMTHRS_RUNTIME_DIR;
  const raw = env.ELIZA_NATIVE_GOOGLE_BINDING_JSON;
  if (!raw && !prepareCloud) return;
  const admissionFailure = (message: string) => prepareCloud
    ? new ElizaError(message, {code: "NATIVE_CLOUD_ROUTING_UNAVAILABLE"})
    : unavailable(message);
  const token = env.ELIZAOS_CLOUD_API_KEY;
  const apiToken = resolveApiToken(env);
  if (
    !isAndroidMobile(env) ||
    !root ||
    (raw !== undefined && raw.length > 8192) ||
    !token ||
    !apiToken ||
    // The managed Gmail and Calendar transports accept only this format; a
    // published endpoint they cannot use would break Gmail reads at plugin init.
    !/^[A-Za-z0-9_-]{64}$/.test(apiToken)
  )
    throw admissionFailure("Native Google host admission is incomplete");
  const filename = path.resolve(entry);
  try {
  const canonicalRoot = fs.realpathSync(root);
  const relative = path.relative(canonicalRoot, filename);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !relative.endsWith(".mjs")
  )
    throw admissionFailure(
      "Native Google host module escaped its admitted resources",
    );
  for (let current = filename; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink())
      throw admissionFailure("Native Google host resources contain a symlink");
    if (current === canonicalRoot) break;
  }
  const manifestFile = path.join(canonicalRoot, "manifest.json");
  const manifestStat = fs.lstatSync(manifestFile);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 1024 * 1024
  )
    throw admissionFailure("Native Google host manifest is invalid");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const stat = fs.lstatSync(filename);
  const expected = manifest.files?.[relative.split(path.sep).join("/")];
  if (
    manifest.version !== 1 ||
    !stat.isFile() ||
    stat.size > 8 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(expected ?? "") ||
    createHash("sha256").update(fs.readFileSync(filename)).digest("hex") !==
      expected
  )
    throw admissionFailure(
      "Native Google host module differs from its admitted manifest",
    );
  } catch {
    throw admissionFailure("Native runtime module admission failed");
  }
  let module: Record<string, unknown>;
  try {
    module = await import(pathToFileURL(filename).href);
    if (prepareCloud) {
      if (typeof module.prepareNativeCloudRuntime !== "function")
        throw new Error("Native Cloud routing preparation is unavailable");
      await module.prepareNativeCloudRuntime();
      if (env.ELIZAOS_CLOUD_API_KEY !== token)
        throw new Error("Native Cloud credential changed during preparation");
    }
  } catch {
    throw admissionFailure("Native runtime preparation failed");
  }
  if (!raw) return;
  let binding: unknown;
  try {
    binding = JSON.parse(raw);
  } catch {
    // A SyntaxError would quote the private binding; report only its absence.
    throw unavailable("Native Google host binding is invalid");
  }
  if (!binding || typeof binding !== "object" || Array.isArray(binding))
    throw unavailable("Native Google host binding is invalid");
  if (typeof module.startNativeGoogleAgentHost !== "function")
    throw unavailable("Native Google host module has no supported entry");
  const host = await module.startNativeGoogleAgentHost({
    binding: { ...binding, token },
    apiToken,
    assertCurrent() {
      if (
        env.ELIZA_NATIVE_GOOGLE_BINDING_JSON !== raw ||
        env.ELIZAOS_CLOUD_API_KEY !== token
      )
        throw unavailable("Native Google owner changed");
    },
  });
  if (
    !Number.isInteger(host?.port) ||
    host.port < 1024 ||
    host.port > 65535 ||
    typeof host.close !== "function"
  ) {
    await host?.close?.();
    throw unavailable("Native Google host did not return a private endpoint");
  }
  const endpoint = `http://127.0.0.1:${host.port}/__alpha-owner-gmail`;
  for (const key of brokerKeys) {
    if (env[key]) {
      await host.close();
      throw unavailable("A managed Google host is already configured");
    }
  }
  const published = brokerKeys.filter(
    (key) =>
      key !== "ELIZA_MANAGED_GMAIL_SEND_BROKER" ||
      enabled(env[NATIVE_GMAIL_SEND_FLAG]),
  );
  for (const key of published) env[key] = endpoint;
  return {
    async close() {
      for (const key of published) if (env[key] === endpoint) delete env[key];
      await host.close();
    },
  };
}

/**
 * Boot callers use this form: the on-device agent must still start when the
 * Google host cannot be admitted (for example before Cloud sign-in). Google
 * stays unavailable, and only a typed code is reported, never host output.
 */
export async function startNativeManagedGoogleHostForBoot(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<{ close(): Promise<void> } | undefined> {
  try {
    return await startNativeManagedGoogleHost(env);
  } catch (error) {
    if (error instanceof ElizaError && error.code === "NATIVE_CLOUD_ROUTING_UNAVAILABLE") throw error;
    const code =
      error instanceof ElizaError && typeof error.code === "string"
        ? error.code
        : "NATIVE_MANAGED_GOOGLE_HOST_FAILED";
    warn(
      `[native-google-host] Google services are unavailable; the agent continues without them (${code}).`,
    );
    return undefined;
  }
}
