/**
 * Remote desktop session framework.
 *
 * Provides a narrow façade over Tailscale / ngrok so the owner can view or
 * control their computer from a phone while the agent is working. Sessions are
 * ephemeral, in-memory, and auto-expire. No secrets are persisted to disk and
 * no passwords are passed on the command line.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RemoteDesktopBackend =
  | "tailscale-vnc"
  | "tailscale-ssh"
  | "ngrok-vnc"
  | "none";

export interface RemoteDesktopSession {
  id: string;
  backend: RemoteDesktopBackend;
  status: "starting" | "active" | "ended" | "failed";
  accessUrl?: string;
  accessCode?: string;
  startedAt: string;
  endedAt?: string;
  expiresAt?: string;
  error?: string;
  mockMode?: boolean;
}

export interface RemoteDesktopConfig {
  preferredBackend?: RemoteDesktopBackend;
  tailscaleNodeName?: string;
  ngrokAuthToken?: string;
  vncPort?: number;
  sessionDurationMinutes?: number;
}

export class RemoteDesktopError extends Error {
  readonly backend: RemoteDesktopBackend;
  constructor(message: string, backend: RemoteDesktopBackend) {
    super(message);
    this.name = "RemoteDesktopError";
    this.backend = backend;
  }
}

// ---------------------------------------------------------------------------
// In-process session store
// ---------------------------------------------------------------------------

interface SessionRuntimeState {
  session: RemoteDesktopSession;
  expiryTimer?: NodeJS.Timeout;
  ngrokProcess?: ChildProcess;
}

const sessions = new Map<string, SessionRuntimeState>();

const DEFAULT_VNC_PORT = 5900;
const DEFAULT_SESSION_MINUTES = 60;

function isMockRemoteDesktopEnabled(): boolean {
  const explicit = process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND?.trim();
  if (explicit) {
    const normalized = explicit.toLowerCase();
    return (
      normalized === "1" ||
      normalized === "true" ||
      normalized === "yes" ||
      normalized === "on" ||
      normalized === "fixture"
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Env / config resolution
// ---------------------------------------------------------------------------

function resolveConfig(
  config?: RemoteDesktopConfig,
  env: NodeJS.ProcessEnv = process.env,
): Required<Pick<RemoteDesktopConfig, "vncPort" | "sessionDurationMinutes">> & {
  preferredBackend?: RemoteDesktopBackend;
  tailscaleNodeName?: string;
  ngrokAuthToken?: string;
} {
  return {
    preferredBackend: config?.preferredBackend,
    tailscaleNodeName:
      config?.tailscaleNodeName ??
      (env.ELIZA_TAILSCALE_NODE?.trim() || undefined),
    ngrokAuthToken:
      config?.ngrokAuthToken ??
      (env.ELIZA_NGROK_AUTH_TOKEN?.trim() || undefined),
    vncPort: config?.vncPort ?? DEFAULT_VNC_PORT,
    sessionDurationMinutes:
      config?.sessionDurationMinutes ?? DEFAULT_SESSION_MINUTES,
  };
}

// ---------------------------------------------------------------------------
// Backend detection probes
// ---------------------------------------------------------------------------

interface TailscaleState {
  authenticated: boolean;
  hostname?: string;
}

async function probeTailscale(): Promise<TailscaleState> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: 3_000,
    });
    const parsed = JSON.parse(stdout) as {
      BackendState?: string;
      Self?: { HostName?: string; DNSName?: string };
    };
    const authenticated = parsed.BackendState === "Running";
    const hostname =
      parsed.Self?.DNSName?.replace(/\.$/, "") || parsed.Self?.HostName;
    return { authenticated, hostname };
  } catch {
    return { authenticated: false };
  }
}

async function probeLocalVncServer(): Promise<boolean> {
  if (process.platform === "darwin") {
    // macOS: screensharing is launchd-managed. Look for the plist as a signal.
    try {
      const { stdout } = await execFileAsync(
        "launchctl",
        ["list", "com.apple.screensharing"],
        { timeout: 2_000 },
      );
      return stdout.includes("com.apple.screensharing");
    } catch {
      return false;
    }
  }
  if (process.platform === "linux") {
    try {
      await execFileAsync("which", ["x11vnc"], { timeout: 2_000 });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function probeNgrok(token?: string): Promise<boolean> {
  if (!token) return false;
  try {
    await execFileAsync("ngrok", ["version"], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectRemoteDesktopBackend(
  config?: RemoteDesktopConfig,
): Promise<RemoteDesktopBackend> {
  if (isMockRemoteDesktopEnabled()) {
    return "tailscale-vnc";
  }
  const resolved = resolveConfig(config);

  if (resolved.preferredBackend === "none") return "none";

  if (resolved.preferredBackend) {
    const available = await backendAvailable(
      resolved.preferredBackend,
      resolved.ngrokAuthToken,
    );
    return available ? resolved.preferredBackend : "none";
  }

  const tailscale = await probeTailscale();
  if (tailscale.authenticated) {
    if (await probeLocalVncServer()) return "tailscale-vnc";
    return "tailscale-ssh";
  }

  if (await probeNgrok(resolved.ngrokAuthToken)) return "ngrok-vnc";

  return "none";
}

async function backendAvailable(
  backend: RemoteDesktopBackend,
  ngrokToken?: string,
): Promise<boolean> {
  if (backend === "none") return true;
  if (backend === "tailscale-vnc") {
    const ts = await probeTailscale();
    return ts.authenticated && (await probeLocalVncServer());
  }
  if (backend === "tailscale-ssh") {
    const ts = await probeTailscale();
    return ts.authenticated;
  }
  if (backend === "ngrok-vnc") {
    return probeNgrok(ngrokToken);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function generatePairingCode(): string {
  // 6-digit numeric code, zero-padded. Sourced from crypto.randomInt.
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function scheduleExpiry(id: string, durationMs: number): NodeJS.Timeout {
  return setTimeout(() => {
    void endRemoteSession(id).catch((error) => {
      logger.warn(
        {
          boundary: "lifeops",
          integration: "remote-desktop",
          sessionId: id,
          err: error instanceof Error ? error : undefined,
        },
        `[remote-desktop] auto-expire failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, durationMs);
}

// ---------------------------------------------------------------------------
// Backend starters
// ---------------------------------------------------------------------------

async function startTailscaleVncSession(args: {
  id: string;
  pairingCode: string;
  vncPort: number;
  tailscaleNodeOverride?: string;
}): Promise<{ accessUrl: string }> {
  const ts = await probeTailscale();
  if (!ts.authenticated) {
    throw new RemoteDesktopError(
      "Tailscale is not authenticated",
      "tailscale-vnc",
    );
  }
  const host = args.tailscaleNodeOverride || ts.hostname;
  if (!host) {
    throw new RemoteDesktopError(
      "Tailscale hostname not discoverable",
      "tailscale-vnc",
    );
  }

  if (process.platform === "darwin") {
    // Do NOT attempt to toggle Screen Sharing via sudo. If the service is not
    // already enabled we surface that clearly to the owner instead of racing a
    // sudo prompt in a background process.
    const vncUp = await probeLocalVncServer();
    if (!vncUp) {
      throw new RemoteDesktopError(
        "macOS Screen Sharing is not enabled. Enable it in System Settings → General → Sharing → Screen Sharing, then retry.",
        "tailscale-vnc",
      );
    }
  }

  // The pairing code is intentionally NOT placed into the URL userinfo — VNC
  // viewers would treat it as a connection password and we have no way to
  // inject it into the running VNC server without changing user credentials.
  // The owner uses it as an out-of-band check when opening the session.
  return {
    accessUrl: `vnc://${host}:${args.vncPort}`,
  };
}

async function startTailscaleSshSession(args: {
  tailscaleNodeOverride?: string;
}): Promise<{ accessUrl: string }> {
  const ts = await probeTailscale();
  if (!ts.authenticated) {
    throw new RemoteDesktopError(
      "Tailscale is not authenticated",
      "tailscale-ssh",
    );
  }
  const host = args.tailscaleNodeOverride || ts.hostname;
  if (!host) {
    throw new RemoteDesktopError(
      "Tailscale hostname not discoverable",
      "tailscale-ssh",
    );
  }
  return { accessUrl: `ssh://${host}` };
}

async function startNgrokVncSession(args: {
  vncPort: number;
  authToken: string;
}): Promise<{ accessUrl: string; child: ChildProcess }> {
  // Feed the auth token via env, never on argv.
  const child = spawn(
    "ngrok",
    ["tcp", String(args.vncPort), "--log=stdout", "--log-format=json"],
    {
      env: { ...process.env, NGROK_AUTHTOKEN: args.authToken },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const accessUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new RemoteDesktopError(
          "ngrok did not report a public URL within 10s",
          "ngrok-vnc",
        ),
      );
    }, 10_000);

    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as { url?: string; msg?: string };
          if (evt.url?.startsWith("tcp://")) {
            clearTimeout(timer);
            child.stdout?.off("data", onStdout);
            resolve(evt.url);
            return;
          }
        } catch {
          // ngrok writes non-JSON lines occasionally; ignore them.
        }
      }
    };
    child.stdout?.on("data", onStdout);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(
        new RemoteDesktopError(`ngrok failed: ${err.message}`, "ngrok-vnc"),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new RemoteDesktopError(
          `ngrok exited prematurely with code ${code}`,
          "ngrok-vnc",
        ),
      );
    });
  });

  return { accessUrl, child };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startRemoteSession(
  config?: RemoteDesktopConfig,
): Promise<RemoteDesktopSession> {
  const resolved = resolveConfig(config);
  const mockEnabled = isMockRemoteDesktopEnabled();
  const backend = await detectRemoteDesktopBackend(config);

  const now = new Date();
  const durationMs = resolved.sessionDurationMinutes * 60_000;
  const id = randomUUID();
  const pairingCode = generatePairingCode();

  const initialSession: RemoteDesktopSession = {
    id,
    backend,
    status: "starting",
    accessCode: pairingCode,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
  };
  sessions.set(id, { session: initialSession });

  if (backend === "none") {
    const failed: RemoteDesktopSession = {
      ...initialSession,
      status: "failed",
      error:
        "No remote-desktop backend available. Configure Tailscale or ngrok.",
      endedAt: new Date().toISOString(),
    };
    sessions.set(id, { session: failed });
    return failed;
  }

  try {
    if (mockEnabled) {
      const activeSession: RemoteDesktopSession = {
        ...initialSession,
        backend,
        status: "active",
        accessUrl: `vnc://127.0.0.1:${resolved.vncPort}/mock/${id}`,
        mockMode: true,
      };
      const expiryTimer = scheduleExpiry(id, durationMs);
      sessions.set(id, {
        session: activeSession,
        expiryTimer,
      });
      return activeSession;
    }

    let accessUrl: string;
    let ngrokProcess: ChildProcess | undefined;

    if (backend === "tailscale-vnc") {
      const result = await startTailscaleVncSession({
        id,
        pairingCode,
        vncPort: resolved.vncPort,
        tailscaleNodeOverride: resolved.tailscaleNodeName,
      });
      accessUrl = result.accessUrl;
    } else if (backend === "tailscale-ssh") {
      const result = await startTailscaleSshSession({
        tailscaleNodeOverride: resolved.tailscaleNodeName,
      });
      accessUrl = result.accessUrl;
    } else {
      if (!resolved.ngrokAuthToken) {
        throw new RemoteDesktopError(
          "ngrok auth token not configured (ELIZA_NGROK_AUTH_TOKEN)",
          "ngrok-vnc",
        );
      }
      const result = await startNgrokVncSession({
        vncPort: resolved.vncPort,
        authToken: resolved.ngrokAuthToken,
      });
      accessUrl = result.accessUrl;
      ngrokProcess = result.child;
    }

    const activeSession: RemoteDesktopSession = {
      ...initialSession,
      status: "active",
      accessUrl,
    };
    const expiryTimer = scheduleExpiry(id, durationMs);
    sessions.set(id, {
      session: activeSession,
      expiryTimer,
      ngrokProcess,
    });

    logger.info(
      {
        boundary: "lifeops",
        integration: "remote-desktop",
        sessionId: id,
        backend,
      },
      `[remote-desktop] session ${id} active via ${backend}`,
    );

    return activeSession;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: RemoteDesktopSession = {
      ...initialSession,
      status: "failed",
      error: message,
      endedAt: new Date().toISOString(),
    };
    sessions.set(id, { session: failed });
    logger.warn(
      {
        boundary: "lifeops",
        integration: "remote-desktop",
        sessionId: id,
        backend,
      },
      `[remote-desktop] session ${id} failed: ${message}`,
    );
    return failed;
  }
}

export async function getSessionStatus(
  id: string,
): Promise<RemoteDesktopSession | null> {
  const entry = sessions.get(id);
  return entry ? entry.session : null;
}

export async function endRemoteSession(id: string): Promise<void> {
  const entry = sessions.get(id);
  if (!entry) return;

  if (entry.expiryTimer) {
    clearTimeout(entry.expiryTimer);
  }
  if (entry.ngrokProcess && entry.ngrokProcess.exitCode === null) {
    entry.ngrokProcess.kill("SIGTERM");
  }

  const ended: RemoteDesktopSession = {
    ...entry.session,
    status: "ended",
    endedAt: new Date().toISOString(),
  };
  sessions.set(id, { session: ended });

  logger.info(
    {
      boundary: "lifeops",
      integration: "remote-desktop",
      sessionId: id,
    },
    `[remote-desktop] session ${id} ended`,
  );
}

export async function listActiveSessions(): Promise<RemoteDesktopSession[]> {
  return Array.from(sessions.values())
    .map((entry) => entry.session)
    .filter(
      (session) => session.status === "active" || session.status === "starting",
    );
}
