import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type LandlockAvailability =
  | "available"
  | "unavailable"
  | "unknown"
  | "not-linux";

type LandlockProbeOptions = {
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  env?: Record<string, string | undefined>;
};

const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const SETTING_OFF = /^(?:off|false|0|none|disabled)$/iu;
const SETTING_ON = /^(?:on|true|1|enabled)$/iu;
const LSM_PATH = "/sys/kernel/security/lsm";
const LANDLOCK_DIR = "/sys/kernel/security/landlock";

export function normalizeCodexSandboxMode(
  value: string | undefined,
): CodexSandboxMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (SETTING_OFF.test(normalized)) return "danger-full-access";
  if (normalized === "readonly") return "read-only";
  if (normalized === "workspace") return "workspace-write";
  return CODEX_SANDBOX_MODES.has(normalized as CodexSandboxMode)
    ? (normalized as CodexSandboxMode)
    : undefined;
}

export function normalizeCodexApprovalPolicy(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return ["untrusted", "on-request", "on-failure", "never"].includes(normalized)
    ? normalized
    : undefined;
}

export function detectLandlockAvailability(
  opts: LandlockProbeOptions = {},
): LandlockAvailability {
  const env = opts.env ?? process.env;
  const override = env.ELIZA_CODEX_ACP_LANDLOCK ?? env.ELIZA_CODEX_LANDLOCK;
  if (override?.trim()) {
    const normalized = override.trim();
    if (SETTING_OFF.test(normalized)) return "unavailable";
    if (SETTING_ON.test(normalized)) return "available";
  }

  const currentPlatform = opts.platform ?? platform();
  if (currentPlatform !== "linux") return "not-linux";

  const exists = opts.existsSync ?? ((path: string) => existsSync(path));
  const read =
    opts.readFileSync ??
    ((path: string, encoding: BufferEncoding) => readFileSync(path, encoding));
  if (exists(LANDLOCK_DIR)) return "available";
  if (!exists(LSM_PATH)) return "unknown";

  try {
    const lsm = read(LSM_PATH, "utf8");
    const enabled = lsm
      .split(/[\s,]+/u)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    return enabled.includes("landlock") ? "available" : "unavailable";
  } catch {
    return "unknown";
  }
}

export function commandHasCodexConfigKey(
  command: string,
  key: string,
): boolean {
  const args = splitCommandLineArgs(command);
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-c" && args[i] !== "--config") continue;
    const value = args[i + 1]?.trim();
    if (value?.startsWith(`${key}=`)) return true;
  }
  return false;
}

export function commandHasCodexSandboxConfig(command: string): boolean {
  const args = splitCommandLineArgs(command);
  return (
    commandHasCodexConfigKey(command, "sandbox_mode") ||
    args.includes("--dangerously-bypass-approvals-and-sandbox") ||
    args.some(
      (arg, index) =>
        arg === "-s" &&
        CODEX_SANDBOX_MODES.has(args[index + 1] as CodexSandboxMode),
    )
  );
}

export function appendCodexAcpSandboxConfig(
  command: string,
  sandboxMode: CodexSandboxMode,
  approvalPolicy?: string,
): string {
  const args: string[] = [];
  if (!commandHasCodexSandboxConfig(command)) {
    args.push("-c", `sandbox_mode=${sandboxMode}`);
  }
  if (approvalPolicy && !commandHasCodexConfigKey(command, "approval_policy")) {
    args.push("-c", `approval_policy=${approvalPolicy}`);
  }
  if (args.length === 0) return command.trim();
  return [command.trim(), ...args].filter(Boolean).join(" ");
}

export function isCodexLandlockPanic(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("landlock") &&
    (normalized.includes("use-legacy-landlock") ||
      normalized.includes("requires direct runtime enforcement") ||
      normalized.includes("linux-sandbox")) &&
    (normalized.includes("panicked") ||
      normalized.includes("code 101") ||
      normalized.includes("exited with code 101"))
  );
}

function splitCommandLineArgs(input: string): string[] {
  return (input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? []).map((part) =>
    part.replace(/^(['"])(.*)\1$/u, "$2"),
  );
}
