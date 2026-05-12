/**
 * Secrets-manager installer + signin orchestration.
 *
 * Drives the lifecycle the UI cares about for the three external secrets-manager
 * backends (1Password, Bitwarden, Proton Pass):
 *
 *   1. **Install**       — spawn the chosen package manager (brew or npm) with
 *                          a clean argv. Streams stdout/stderr lines back to
 *                          subscribers, emits a final `done` / `error` event
 *                          when the child exits.
 *   2. **Sign in**       — runs the vendor's non-interactive signin flow with
 *                          credentials supplied once via the API. Captures the
 *                          session token from stdout and persists it in the
 *                          in-house vault as `pm.<backend>.session`.
 *   3. **Sign out**      — clears the persisted session token.
 *
 * Master passwords / API secrets enter the process exactly once per request
 * via `child.stdin`; they are never written to disk. The session tokens that
 * come back are integration metadata (not user secrets), but we still mark
 * them `sensitive: true` so they're encrypted at rest under the OS keychain.
 *
 * Singleton: one installer per process, owns a Map<jobId, InstallJob>. The
 * stream of events is also persisted in-memory on the job so a UI that
 * subscribes after spawn (race) can replay history.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  type BackendId,
  buildInstallCommand,
  createManager,
  type InstallMethod,
  resolveRunnableMethods,
  type SecretsManager,
} from "@elizaos/vault";

export type InstallableBackendId = Exclude<BackendId, "in-house">;

export type InstallJobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type InstallJobEvent =
  | {
      readonly type: "log";
      readonly stream: "stdout" | "stderr";
      readonly line: string;
    }
  | { readonly type: "status"; readonly status: InstallJobStatus }
  | { readonly type: "done"; readonly exitCode: number }
  | { readonly type: "error"; readonly message: string };

export interface InstallJobSnapshot {
  readonly id: string;
  readonly backendId: InstallableBackendId;
  readonly method: InstallMethod;
  readonly status: InstallJobStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
  readonly history: readonly InstallJobEvent[];
}

interface MutableJob {
  id: string;
  backendId: InstallableBackendId;
  method: InstallMethod;
  status: InstallJobStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  history: InstallJobEvent[];
  emitter: EventEmitter;
  child: ChildProcess | null;
}

/**
 * Injectable spawn for tests. Production callers omit this and get the real
 * `node:child_process` `spawn`. Tests pass a stub that returns a synthetic
 * `ChildProcess`-like object so we don't actually fork brew/npm.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ["ignore" | "pipe", "pipe", "pipe"];
    shell: false;
    env?: NodeJS.ProcessEnv;
  },
) => ChildProcess;

export interface InstallerDependencies {
  readonly manager: SecretsManager;
  readonly spawn?: SpawnFn;
}

export interface SigninRequest {
  readonly backendId: InstallableBackendId;
  /** 1Password: required. Bitwarden: required (`bw login` email + master pwd). */
  readonly email?: string;
  /** Master password (the user's main vault password). Used only in this request. */
  readonly masterPassword: string;
  /** 1Password: required. The 34-char "Secret Key". */
  readonly secretKey?: string;
  /** 1Password: optional sign-in URL (defaults to `my.1password.com`). */
  readonly signInAddress?: string;
  /** Bitwarden: API client_id (BW_CLIENTID). Enables the non-interactive login flow. */
  readonly bitwardenClientId?: string;
  /** Bitwarden: API client_secret (BW_CLIENTSECRET). */
  readonly bitwardenClientSecret?: string;
}

export interface SigninResult {
  readonly backendId: InstallableBackendId;
  readonly sessionStored: boolean;
  /** Truncated, human-readable detail surfaced from the CLI. Never the secret itself. */
  readonly message: string;
}

const SESSION_KEY_PREFIX = "pm";

function sessionKey(backendId: InstallableBackendId): string {
  return `${SESSION_KEY_PREFIX}.${backendId}.session`;
}

const MAX_LINE_LENGTH = 2_000;
const MAX_HISTORY_EVENTS = 500;
const DEFAULT_SIGNIN_TIMEOUT_MS = 60_000;

export class SecretsManagerInstaller {
  private readonly jobs = new Map<string, MutableJob>();
  private readonly manager: SecretsManager;
  private readonly spawn: SpawnFn;

  constructor(deps: InstallerDependencies) {
    this.manager = deps.manager;
    this.spawn = deps.spawn ?? (nodeSpawn as SpawnFn);
  }

  /** Snapshot of the install methods runnable on this host for a backend. */
  async getInstallMethods(
    id: InstallableBackendId,
  ): Promise<readonly InstallMethod[]> {
    return resolveRunnableMethods(id);
  }

  /**
   * Spawn the install command for `method` on backend `id`. Returns a job id
   * the UI can subscribe to. The caller is expected to call `subscribeJob`
   * (or read `getJob` to poll) before the child finishes; events that fire
   * before the first subscriber are kept on `job.history` so SSE clients
   * that connect after spawn still see the full log.
   */
  startInstall(
    id: InstallableBackendId,
    method: InstallMethod,
  ): InstallJobSnapshot {
    if (method.kind === "manual") {
      throw new TypeError(
        `Cannot automate install for "${id}": method is manual. Direct the user to ${method.url}`,
      );
    }
    const built = buildInstallCommand(method);
    if (!built) {
      throw new Error(
        `buildInstallCommand returned null for non-manual method (${method.kind})`,
      );
    }
    const job: MutableJob = {
      id: randomUUID(),
      backendId: id,
      method,
      status: "pending",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      errorMessage: null,
      history: [],
      emitter: new EventEmitter(),
      child: null,
    };
    this.jobs.set(job.id, job);

    setImmediate(() => this.runInstallJob(job, built.command, built.args));

    return snapshotOf(job);
  }

  /** Subscribe to events for a running job. Returns an unsubscribe function. */
  subscribeJob(
    jobId: string,
    listener: (event: InstallJobEvent) => void,
  ): () => void {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown install job: ${jobId}`);
    // Replay history first so a late subscriber catches up.
    for (const event of job.history) listener(event);
    if (job.status !== "running" && job.status !== "pending") {
      // Already terminal; nothing more will fire. Replay covered it.
      return () => undefined;
    }
    job.emitter.on("event", listener);
    return () => job.emitter.off("event", listener);
  }

  getJob(jobId: string): InstallJobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job ? snapshotOf(job) : null;
  }

  /**
   * Run the vendor's non-interactive signin flow and persist the session token.
   * Throws on validation or CLI failure with a message safe to surface to UI.
   */
  async signIn(request: SigninRequest): Promise<SigninResult> {
    if (request.backendId === "1password") {
      return this.signInOnePassword(request);
    }
    if (request.backendId === "bitwarden") {
      return this.signInBitwarden(request);
    }
    throw new Error(
      `Sign-in for "${request.backendId}" is not implemented. Vendor CLI is unstable.`,
    );
  }

  async signOut(backendId: InstallableBackendId): Promise<void> {
    if (await this.manager.has(sessionKey(backendId))) {
      await this.manager.remove(sessionKey(backendId));
    }
  }

  /** Read the cached session token (or null if not signed in). */
  async getSession(backendId: InstallableBackendId): Promise<string | null> {
    if (!(await this.manager.has(sessionKey(backendId)))) return null;
    return this.manager.get(sessionKey(backendId));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private runInstallJob(
    job: MutableJob,
    command: string,
    args: readonly string[],
  ): void {
    this.transition(job, "running");
    const child = this.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    job.child = child;

    const onLine = (stream: "stdout" | "stderr", line: string) => {
      this.emit(job, {
        type: "log",
        stream,
        line:
          line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line,
      });
    };

    pipeLines(child.stdout, (line) => onLine("stdout", line));
    pipeLines(child.stderr, (line) => onLine("stderr", line));

    child.on("error", (err) => {
      // ENOENT here means the package manager binary disappeared between
      // detection and spawn — surface explicitly rather than masking as
      // exitCode=1.
      const message =
        err instanceof Error
          ? err.message
          : `unknown spawn error: ${String(err)}`;
      job.errorMessage = message;
      this.emit(job, { type: "error", message });
      this.terminate(job, "failed", null);
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      job.exitCode = exitCode;
      if (exitCode === 0) {
        this.emit(job, { type: "done", exitCode });
        this.terminate(job, "succeeded", exitCode);
      } else {
        const message = `install exited with code ${exitCode}`;
        job.errorMessage = message;
        this.emit(job, { type: "error", message });
        this.terminate(job, "failed", exitCode);
      }
    });
  }

  private emit(job: MutableJob, event: InstallJobEvent): void {
    job.history.push(event);
    if (job.history.length > MAX_HISTORY_EVENTS) {
      job.history = job.history.slice(-MAX_HISTORY_EVENTS / 2);
    }
    job.emitter.emit("event", event);
  }

  private transition(job: MutableJob, next: InstallJobStatus): void {
    job.status = next;
    this.emit(job, { type: "status", status: next });
  }

  private terminate(
    job: MutableJob,
    final: InstallJobStatus,
    exitCode: number | null,
  ): void {
    job.endedAt = Date.now();
    job.exitCode = exitCode;
    this.transition(job, final);
    job.emitter.removeAllListeners();
    job.child = null;
  }

  // ── Sign-in flows ────────────────────────────────────────────────────────

  /**
   * Adds a 1Password account (idempotent — if the account already exists `op`
   * succeeds without re-prompting), then performs `op signin --raw` piping
   * the master password on stdin. Captures the session token returned on
   * stdout and persists it under `pm.1password.session`.
   */
  private async signInOnePassword(
    request: SigninRequest,
  ): Promise<SigninResult> {
    if (!request.email) throw new Error("1Password sign-in requires `email`");
    if (!request.secretKey)
      throw new Error(
        "1Password sign-in requires `secretKey` (the 34-char Secret Key)",
      );
    if (!request.masterPassword)
      throw new Error("1Password sign-in requires `masterPassword`");

    const signInAddress = request.signInAddress?.trim() || "my.1password.com";

    const addArgs = [
      "account",
      "add",
      "--address",
      signInAddress,
      "--email",
      request.email,
      "--secret-key",
      request.secretKey,
      "--signin",
      "--raw",
    ];
    const add = await spawnCapture(
      this.spawn,
      "op",
      addArgs,
      request.masterPassword,
    );

    let sessionToken = add.stdout.trim();
    // If the account already exists, `op account add` may exit 0 without
    // emitting a session token. Fall back to `op signin --raw` to obtain one.
    if (!sessionToken) {
      const signin = await spawnCapture(
        this.spawn,
        "op",
        ["signin", "--account", signInAddress, "--raw"],
        request.masterPassword,
      );
      if (signin.exitCode !== 0 || !signin.stdout.trim()) {
        throw new Error(
          truncateError(
            `op signin failed (exit ${signin.exitCode}): ${signin.stderr || signin.stdout}`,
          ),
        );
      }
      sessionToken = signin.stdout.trim();
    }

    if (add.exitCode !== 0 && !sessionToken) {
      throw new Error(
        truncateError(
          `op account add failed (exit ${add.exitCode}): ${add.stderr || add.stdout}`,
        ),
      );
    }

    await this.manager.vault.set(sessionKey("1password"), sessionToken, {
      sensitive: true,
      caller: "secrets-manager-installer",
    });

    return {
      backendId: "1password",
      sessionStored: true,
      message: `Signed in as ${request.email} at ${signInAddress}`,
    };
  }

  /**
   * Bitwarden non-interactive flow:
   *   1. `bw login --apikey` with BW_CLIENTID / BW_CLIENTSECRET in env
   *   2. `bw unlock --raw` piping the master password on stdin
   * Captures the session token from `bw unlock --raw` and persists it.
   */
  private async signInBitwarden(request: SigninRequest): Promise<SigninResult> {
    if (!request.bitwardenClientId)
      throw new Error(
        "Bitwarden sign-in requires `bitwardenClientId` (BW_CLIENTID)",
      );
    if (!request.bitwardenClientSecret)
      throw new Error(
        "Bitwarden sign-in requires `bitwardenClientSecret` (BW_CLIENTSECRET)",
      );
    if (!request.masterPassword)
      throw new Error("Bitwarden sign-in requires `masterPassword`");

    const env = {
      ...process.env,
      BW_CLIENTID: request.bitwardenClientId,
      BW_CLIENTSECRET: request.bitwardenClientSecret,
    };
    // `bw login --apikey` is idempotent: if already logged in, it exits 1
    // with "You are already logged in as ...". We treat that as success and
    // proceed to unlock.
    const login = await spawnCapture(
      this.spawn,
      "bw",
      ["login", "--apikey"],
      null,
      env,
    );
    const alreadyLoggedIn =
      login.exitCode !== 0 &&
      /already logged in/i.test(login.stderr + login.stdout);
    if (login.exitCode !== 0 && !alreadyLoggedIn) {
      throw new Error(
        truncateError(
          `bw login failed (exit ${login.exitCode}): ${login.stderr || login.stdout}`,
        ),
      );
    }

    const unlock = await spawnCapture(
      this.spawn,
      "bw",
      ["unlock", "--raw", "--passwordenv", "BW_PASSWORD"],
      null,
      { ...env, BW_PASSWORD: request.masterPassword },
    );
    const sessionToken = unlock.stdout.trim();
    if (unlock.exitCode !== 0 || !sessionToken) {
      throw new Error(
        truncateError(
          `bw unlock failed (exit ${unlock.exitCode}): ${unlock.stderr || unlock.stdout}`,
        ),
      );
    }

    await this.manager.vault.set(sessionKey("bitwarden"), sessionToken, {
      sensitive: true,
      caller: "secrets-manager-installer",
    });

    return {
      backendId: "bitwarden",
      sessionStored: true,
      message: alreadyLoggedIn
        ? "Already logged in; vault unlocked"
        : "Signed in via API key; vault unlocked",
    };
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

interface CapturedExec {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a child process with optional stdin, capture stdout/stderr, return
 * when it exits. Hard timeout via SIGKILL; never leaves a dangling child.
 */
function spawnCapture(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  stdin: string | null,
  env?: NodeJS.ProcessEnv,
  timeoutMs = DEFAULT_SIGNIN_TIMEOUT_MS,
): Promise<CapturedExec> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
      env: env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    if (stdin !== null && child.stdin) {
      child.stdin.end(stdin);
    }
  });
}

function pipeLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return;
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let newlineIdx = buf.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = buf.slice(0, newlineIdx).replace(/\r$/, "");
      buf = buf.slice(newlineIdx + 1);
      onLine(line);
      newlineIdx = buf.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buf.length > 0) {
      onLine(buf);
      buf = "";
    }
  });
}

function snapshotOf(job: MutableJob): InstallJobSnapshot {
  return {
    id: job.id,
    backendId: job.backendId,
    method: job.method,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    errorMessage: job.errorMessage,
    history: [...job.history],
  };
}

function truncateError(message: string, max = 800): string {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _installer: SecretsManagerInstaller | null = null;

export function getSecretsManagerInstaller(
  manager?: SecretsManager,
): SecretsManagerInstaller {
  if (!_installer) {
    _installer = new SecretsManagerInstaller({
      manager: manager ?? createManager(),
    });
  }
  return _installer;
}

/** Test hook. Replace the singleton entirely (e.g. with a fake spawn). */
export function _setSecretsManagerInstallerForTesting(
  next: SecretsManagerInstaller | null,
): void {
  _installer = next;
}

/** Test hook. */
export function _resetSecretsManagerInstallerForTesting(): void {
  _installer = null;
}
