import { readFileSync } from "node:fs";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "on-failure"
  | "never";

export type CodexLandlockFallbackReason = "codex-landlock-unavailable";

export type CodexLandlockFallbackEvent = {
  reason: CodexLandlockFallbackReason;
  command: string;
};

export type CodexAcpCommandConfig = {
  command: string;
  landlockFallbackCommand?: string;
  noLandlockDetected: boolean;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  invalidSettings: Array<{ key: string; value: string }>;
};

type SettingReader = (key: string) => string | undefined;

type LandlockOptions = {
  platform?: NodeJS.Platform;
  readLinuxSecurityModules?: () => string | undefined;
};

const SANDBOX_MODE_SETTINGS = [
  "ELIZA_CODEX_ACP_SANDBOX_MODE",
  "ELIZA_CODEX_SANDBOX_MODE",
  "CODEX_EXEC_SANDBOX_MODE",
  "CODING_AGENT_SANDBOX",
] as const;

const NO_LANDLOCK_SANDBOX_MODE_SETTINGS = [
  "ELIZA_CODEX_ACP_NO_LANDLOCK_SANDBOX_MODE",
  "ELIZA_CODEX_NO_LANDLOCK_SANDBOX_MODE",
] as const;

const APPROVAL_POLICY_SETTINGS = [
  "ELIZA_CODEX_ACP_APPROVAL_POLICY",
  "ELIZA_CODEX_APPROVAL_POLICY",
  "CODEX_APPROVAL_POLICY",
] as const;

const NO_LANDLOCK_APPROVAL_POLICY_SETTINGS = [
  "ELIZA_CODEX_ACP_NO_LANDLOCK_APPROVAL_POLICY",
  "ELIZA_CODEX_NO_LANDLOCK_APPROVAL_POLICY",
] as const;

const LANDLOCK_AVAILABLE_SETTINGS = [
  "ELIZA_CODEX_ACP_LANDLOCK_AVAILABLE",
  "ELIZA_CODEX_LANDLOCK_AVAILABLE",
] as const;

const DEFAULT_NO_LANDLOCK_SANDBOX_MODE: CodexSandboxMode = "danger-full-access";
const DEFAULT_NO_LANDLOCK_APPROVAL_POLICY: CodexApprovalPolicy = "never";
const STDERR_TAIL_LIMIT = 16 * 1024;

export function resolveCodexAcpCommand(
  baseCommand: string,
  setting: SettingReader,
  options: LandlockOptions = {},
): CodexAcpCommandConfig {
  const command = baseCommand.trim();
  const invalidSettings: Array<{ key: string; value: string }> = [];
  const explicitMode = readSandboxMode(setting, SANDBOX_MODE_SETTINGS, {
    invalidSettings,
  });
  const explicitApprovalPolicy = readApprovalPolicy(
    setting,
    APPROVAL_POLICY_SETTINGS,
    { invalidSettings },
  );
  const hasSandboxConfig = commandHasCodexSandboxConfig(command);
  const hasApprovalPolicyConfig = commandHasCodexApprovalPolicyConfig(command);

  if (explicitMode) {
    return {
      command: appendCodexConfig(command, {
        sandboxMode: hasSandboxConfig ? undefined : explicitMode,
        approvalPolicy: hasApprovalPolicyConfig
          ? undefined
          : explicitApprovalPolicy,
      }),
      noLandlockDetected: false,
      sandboxMode: explicitMode,
      approvalPolicy: explicitApprovalPolicy,
      invalidSettings,
    };
  }

  const fallbackMode =
    readSandboxMode(setting, NO_LANDLOCK_SANDBOX_MODE_SETTINGS, {
      invalidSettings,
    }) ?? DEFAULT_NO_LANDLOCK_SANDBOX_MODE;
  const fallbackApprovalPolicy =
    explicitApprovalPolicy ??
    readApprovalPolicy(setting, NO_LANDLOCK_APPROVAL_POLICY_SETTINGS, {
      invalidSettings,
    }) ??
    DEFAULT_NO_LANDLOCK_APPROVAL_POLICY;

  const fallbackCommand = hasSandboxConfig
    ? undefined
    : appendCodexConfig(command, {
        sandboxMode: fallbackMode,
        approvalPolicy: hasApprovalPolicyConfig
          ? undefined
          : fallbackApprovalPolicy,
      });
  const landlockAvailable = detectLandlockAvailability(setting, options);
  const noLandlockDetected = landlockAvailable === false;

  if (noLandlockDetected && fallbackCommand) {
    return {
      command: fallbackCommand,
      noLandlockDetected: true,
      sandboxMode: fallbackMode,
      approvalPolicy: fallbackApprovalPolicy,
      invalidSettings,
    };
  }

  return {
    command,
    landlockFallbackCommand:
      fallbackCommand && fallbackCommand !== command
        ? fallbackCommand
        : undefined,
    noLandlockDetected,
    sandboxMode: fallbackCommand ? fallbackMode : undefined,
    approvalPolicy: fallbackCommand ? fallbackApprovalPolicy : undefined,
    invalidSettings,
  };
}

export function isCodexLandlockPanicExit(input: {
  code: number | null;
  stderr: string;
}): boolean {
  if (input.code !== 101) return false;
  return (
    /permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock/iu.test(
      input.stderr,
    ) || /landlock/iu.test(input.stderr)
  );
}

export function appendCodexStderrTail(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= STDERR_TAIL_LIMIT) return next;
  return next.slice(-STDERR_TAIL_LIMIT);
}

function detectLandlockAvailability(
  setting: SettingReader,
  options: LandlockOptions,
): boolean | undefined {
  const forced = readBoolSetting(setting, LANDLOCK_AVAILABLE_SETTINGS);
  if (forced !== undefined) return forced;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return true;
  const raw = readLinuxSecurityModules(options);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes("landlock");
}

function readLinuxSecurityModules(
  options: LandlockOptions,
): string | undefined {
  if (options.readLinuxSecurityModules) {
    return options.readLinuxSecurityModules();
  }
  try {
    return readFileSync("/sys/kernel/security/lsm", "utf8");
  } catch {
    return undefined;
  }
}

function appendCodexConfig(
  command: string,
  opts: {
    sandboxMode?: CodexSandboxMode;
    approvalPolicy?: CodexApprovalPolicy;
  },
): string {
  const args: string[] = [];
  if (opts.sandboxMode) args.push("-c", `sandbox_mode="${opts.sandboxMode}"`);
  if (opts.approvalPolicy)
    args.push("-c", `approval_policy="${opts.approvalPolicy}"`);
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function commandHasCodexSandboxConfig(command: string): boolean {
  return (
    /\bsandbox_mode\b/u.test(command) ||
    /\b--dangerously-bypass-approvals-and-sandbox\b/u.test(command) ||
    /\s-s\s+(read-only|workspace-write|danger-full-access)(\s|$)/u.test(
      ` ${command} `,
    )
  );
}

function commandHasCodexApprovalPolicyConfig(command: string): boolean {
  return /\bapproval_policy\b/u.test(command);
}

function readSandboxMode(
  setting: SettingReader,
  keys: readonly string[],
  opts: { invalidSettings: Array<{ key: string; value: string }> },
): CodexSandboxMode | undefined {
  const entry = firstSetting(setting, keys);
  if (!entry) return undefined;
  const mode = parseSandboxMode(entry.value);
  if (mode) return mode;
  opts.invalidSettings.push(entry);
  return undefined;
}

function parseSandboxMode(value: string): CodexSandboxMode | undefined {
  const normalized = value.trim().toLowerCase().replace(/_/gu, "-");
  if (normalized === "read-only" || normalized === "readonly") {
    return "read-only";
  }
  if (normalized === "workspace-write" || normalized === "workspace") {
    return "workspace-write";
  }
  if (
    normalized === "danger-full-access" ||
    normalized === "danger" ||
    normalized === "full-access" ||
    normalized === "off" ||
    normalized === "none" ||
    normalized === "disabled" ||
    normalized === "false" ||
    normalized === "0"
  ) {
    return "danger-full-access";
  }
  return undefined;
}

function readApprovalPolicy(
  setting: SettingReader,
  keys: readonly string[],
  opts: { invalidSettings: Array<{ key: string; value: string }> },
): CodexApprovalPolicy | undefined {
  const entry = firstSetting(setting, keys);
  if (!entry) return undefined;
  const normalized = entry.value.trim().toLowerCase().replace(/_/gu, "-");
  if (
    normalized === "untrusted" ||
    normalized === "on-request" ||
    normalized === "on-failure" ||
    normalized === "never"
  ) {
    return normalized;
  }
  opts.invalidSettings.push(entry);
  return undefined;
}

function readBoolSetting(
  setting: SettingReader,
  keys: readonly string[],
): boolean | undefined {
  const entry = firstSetting(setting, keys);
  if (!entry) return undefined;
  const normalized = entry.value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function firstSetting(
  setting: SettingReader,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = setting(key)?.trim();
    if (value) return { key, value };
  }
  return undefined;
}
