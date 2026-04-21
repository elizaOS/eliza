import { type SpawnOptions, spawn } from "node:child_process";
import { logger } from "@elizaos/core";

export type RemoteTransport = "tailscale" | "cloud" | "local";

export interface TailscaleStatus {
  available: boolean;
  nodeName?: string;
  magicDNSName?: string;
  tailnet?: string;
  reason?: string;
}

export interface ReservePortOptions {
  background?: boolean;
}

export interface ReservedPort {
  magicDNSUrl: string;
}

interface TailscaleStatusJson {
  BackendState?: string;
  CurrentTailnet?: {
    Name?: string;
    MagicDNSSuffix?: string;
  } | null;
  Self?: {
    HostName?: string;
    DNSName?: string;
    TailscaleIPs?: string[];
  };
}

export interface ProcessRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    options?: { detached?: boolean },
  ): Promise<ProcessResult>;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const TAILSCALE_BIN = "tailscale";
const INSTALL_INSTRUCTIONS =
  "Install Tailscale from https://tailscale.com/download and ensure the `tailscale` CLI is on PATH.";

class DefaultProcessRunner implements ProcessRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    options: { detached?: boolean } = {},
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const spawnOptions: SpawnOptions = {
        detached: options.detached === true,
        stdio:
          options.detached === true ? "ignore" : ["ignore", "pipe", "pipe"],
      };
      const child = spawn(command, Array.from(args), spawnOptions);

      if (options.detached === true) {
        child.on("error", (err) => {
          reject(err);
        });
        child.unref();
        // Detached launches cannot report their own exit reliably. We resolve
        // optimistically; callers that need durability should `tailscale serve
        // status` separately.
        resolve({ exitCode: 0, stdout: "", stderr: "" });
        return;
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        reject(err);
      });
      child.on("close", (code) => {
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  }
}

let activeRunner: ProcessRunner = new DefaultProcessRunner();

export function __setProcessRunnerForTests(runner: ProcessRunner): void {
  activeRunner = runner;
}

export function __resetProcessRunnerForTests(): void {
  activeRunner = new DefaultProcessRunner();
}

// ---------- Public API ----------

export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  const result = await runCli(["status", "--json"]);

  if (result.kind === "missing-binary") {
    logger.warn(
      `[TailscaleTransport] tailscale CLI not found on PATH. ${INSTALL_INSTRUCTIONS}`,
    );
    return { available: false, reason: "tailscale-cli-not-installed" };
  }

  if (result.kind === "failed") {
    logger.warn(
      { exitCode: result.exitCode, stderr: result.stderr },
      "[TailscaleTransport] `tailscale status --json` failed",
    );
    return { available: false, reason: "tailscale-status-failed" };
  }

  const parsed = parseStatusJson(result.stdout);
  if (parsed === null) {
    return { available: false, reason: "tailscale-status-unparseable" };
  }

  if (parsed.BackendState !== "Running") {
    return {
      available: false,
      reason: `tailscale-backend-${parsed.BackendState ?? "unknown"}`,
    };
  }

  const self = parsed.Self;
  if (!self?.HostName) {
    return { available: false, reason: "tailscale-self-node-missing" };
  }

  const tailnet = parsed.CurrentTailnet?.Name;
  const suffix = parsed.CurrentTailnet?.MagicDNSSuffix;
  const magicDNSName = resolveMagicDnsName(self.DNSName, self.HostName, suffix);

  return {
    available: true,
    nodeName: self.HostName,
    magicDNSName,
    tailnet,
  };
}

export async function reserveServerPort(
  port: number,
  options: ReservePortOptions = {},
): Promise<ReservedPort> {
  assertValidPort(port);

  const status = await getTailscaleStatus();
  if (!status.available) {
    throw new Error(
      `Cannot reserve Tailscale port: ${status.reason ?? "unavailable"}`,
    );
  }
  if (!status.magicDNSName) {
    throw new Error(
      "Cannot reserve Tailscale port: magicDNS name not resolvable for this node",
    );
  }

  const args = ["serve", "--bg", "https:/", `https://localhost:${port}`];
  const argsForeground = ["serve", "https:/", `https://localhost:${port}`];
  const chosenArgs = options.background === true ? args : argsForeground;

  const result = await runCli(chosenArgs, {
    detached: options.background === true,
  });

  if (result.kind === "missing-binary") {
    throw new Error(`tailscale CLI not installed. ${INSTALL_INSTRUCTIONS}`);
  }
  if (result.kind === "failed") {
    throw new Error(
      `\`tailscale serve\` failed (exit ${result.exitCode}): ${result.stderr.trim() || "unknown error"}`,
    );
  }

  const magicDNSUrl = `https://${status.magicDNSName}`;
  logger.info(
    { port, magicDNSUrl, background: options.background === true },
    "[TailscaleTransport] reserved tailnet ingress",
  );
  return { magicDNSUrl };
}

export async function releasePort(port: number): Promise<void> {
  assertValidPort(port);

  const result = await runCli(["serve", "--https=443", "off"]);
  if (result.kind === "missing-binary") {
    throw new Error(`tailscale CLI not installed. ${INSTALL_INSTRUCTIONS}`);
  }
  if (result.kind === "failed") {
    // `tailscale serve ... off` is idempotent; non-zero may mean "already off".
    // Log at debug — callers don't need to care.
    logger.debug(
      { port, exitCode: result.exitCode, stderr: result.stderr },
      "[TailscaleTransport] `tailscale serve off` returned non-zero (likely idempotent)",
    );
    return;
  }
  logger.info({ port }, "[TailscaleTransport] released tailnet ingress");
}

export function selectRemoteTransport(
  envValue: string | undefined,
): RemoteTransport {
  if (
    envValue === "tailscale" ||
    envValue === "cloud" ||
    envValue === "local"
  ) {
    return envValue;
  }
  return "local";
}

// ---------- Internals ----------

type CliResult =
  | { kind: "ok"; stdout: string }
  | { kind: "missing-binary" }
  | { kind: "failed"; exitCode: number; stderr: string };

async function runCli(
  args: ReadonlyArray<string>,
  options: { detached?: boolean } = {},
): Promise<CliResult> {
  try {
    const result = await activeRunner.run(TAILSCALE_BIN, args, options);
    if (result.exitCode === 0) {
      return { kind: "ok", stdout: result.stdout };
    }
    return {
      kind: "failed",
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  } catch (err) {
    if (isEnoent(err)) {
      return { kind: "missing-binary" };
    }
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

function parseStatusJson(stdout: string): TailscaleStatusJson | null {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  // Shape-check the fields we actually read.
  const obj = parsed as Record<string, unknown>;
  const out: TailscaleStatusJson = {};
  if (typeof obj.BackendState === "string") {
    out.BackendState = obj.BackendState;
  }
  if (typeof obj.CurrentTailnet === "object" && obj.CurrentTailnet !== null) {
    const ct = obj.CurrentTailnet as Record<string, unknown>;
    out.CurrentTailnet = {
      Name: typeof ct.Name === "string" ? ct.Name : undefined,
      MagicDNSSuffix:
        typeof ct.MagicDNSSuffix === "string" ? ct.MagicDNSSuffix : undefined,
    };
  }
  if (typeof obj.Self === "object" && obj.Self !== null) {
    const self = obj.Self as Record<string, unknown>;
    const ips = Array.isArray(self.TailscaleIPs)
      ? self.TailscaleIPs.filter((x): x is string => typeof x === "string")
      : undefined;
    out.Self = {
      HostName: typeof self.HostName === "string" ? self.HostName : undefined,
      DNSName: typeof self.DNSName === "string" ? self.DNSName : undefined,
      TailscaleIPs: ips,
    };
  }
  return out;
}

function resolveMagicDnsName(
  dnsName: string | undefined,
  hostName: string,
  suffix: string | undefined,
): string | undefined {
  // Tailscale emits DNSName as "host.tailnet.ts.net." — trust it when present.
  if (dnsName && dnsName.length > 0) {
    return dnsName.endsWith(".") ? dnsName.slice(0, -1) : dnsName;
  }
  if (suffix && suffix.length > 0) {
    const cleaned = suffix.startsWith(".") ? suffix.slice(1) : suffix;
    return `${hostName}.${cleaned}`;
  }
  return undefined;
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }
}
