/**
 * REST client for upstream llama.cpp's per-slot KV checkpoint endpoints:
 *
 *   - `POST /slots/<id>/save?filename=<name>`     — snapshot the slot to disk
 *   - `POST /slots/<id>/restore?filename=<name>`  — reload a snapshot
 *   - `DELETE /slots/<id>`                        — cancel in-flight decode
 *
 * Combined with the `--ctx-checkpoints` / `--ctx-checkpoint-interval` flags
 * (wired into `dflash-server.ts`), this is the substrate for the voice
 * optimistic-rollback path: `OptimisticRollbackController` snapshots a slot
 * on `speech-pause`, runs the drafter speculatively against the partial
 * transcript, and restores the snapshot if the user resumes within the
 * rollback window.
 *
 * Upstream feature lands in `master`; our buun-llama-cpp fork hasn't merged
 * the 44-file quant-id conflict yet. The JS code paths ship today behind a
 * feature flag (`enableOptimisticRollback`, default `false`); the moment the
 * upstream merge lands the runtime probe in `dflash-server.ts` flips, the
 * flag can be turned on, and these calls become live.
 */

/**
 * Handle returned from `saveCheckpoint`. Identifies a specific snapshot so
 * later `restoreCheckpoint` / `deleteCheckpoint` calls reference the same
 * file on disk regardless of upstream naming changes.
 */
export interface CheckpointHandle {
  /** Slot id that owns this checkpoint. */
  slotId: number;
  /** Filename passed to `?filename=`; also the on-disk identifier. */
  filename: string;
  /** ISO timestamp captured at save time, for telemetry / TTL. */
  createdAt: string;
}

/**
 * Minimal `fetch` shape. Avoids dragging a DOM lib reference into a Node
 * codebase and lets tests inject a fake without monkey-patching globals.
 */
export type CheckpointFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

/**
 * Thrown when a checkpoint REST call returns a non-2xx response. Carries the
 * HTTP status + the server's response body for diagnostic logging.
 */
export class CheckpointHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;
  constructor(message: string, status: number, responseBody: string) {
    super(message);
    this.name = "CheckpointHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Constructor options for `CheckpointClient`. `baseUrl` is the same
 * `http://host:port` the engine uses for `/v1/chat/completions`.
 */
export interface CheckpointClientOptions {
  baseUrl: string;
  fetchImpl?: CheckpointFetch;
  /**
   * Default per-request timeout (ms). Individual calls may override via
   * an explicit `AbortSignal`. The default is short — restore is the
   * latency-critical path on a `speech-active` resume.
   */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;

/**
 * REST client for the per-slot checkpoint endpoints. Stateless — all
 * checkpoint identity travels through the `CheckpointHandle` returned from
 * `saveCheckpoint`.
 */
export class CheckpointClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: CheckpointFetch;
  private readonly requestTimeoutMs: number;

  constructor(opts: CheckpointClientOptions) {
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Snapshot slot `slotId` to a file named `name`. The server keeps the
   * file under `--slot-save-path`; the returned handle records both pieces
   * so the caller can `restoreCheckpoint` later without re-deriving the
   * filename.
   */
  async saveCheckpoint(
    slotId: number,
    name: string,
    signal?: AbortSignal,
  ): Promise<CheckpointHandle> {
    assertSlotId(slotId);
    assertCheckpointName(name);
    await this.request(
      `/slots/${slotId}/save?filename=${encodeURIComponent(name)}`,
      "POST",
      signal,
    );
    return {
      slotId,
      filename: name,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Restore slot `slotId` from a previously-saved file named `name`.
   * Rejects with `CheckpointHttpError` when the server reports the
   * checkpoint missing.
   */
  async restoreCheckpoint(
    slotId: number,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertSlotId(slotId);
    assertCheckpointName(name);
    await this.request(
      `/slots/${slotId}/restore?filename=${encodeURIComponent(name)}`,
      "POST",
      signal,
    );
  }

  /**
   * Cancel any in-flight generation on slot `slotId`. Maps to upstream
   * `DELETE /slots/<id>`. Used by `OptimisticRollbackController` to abort
   * the speculative drafter when the VAD reports the user resumed
   * speaking.
   */
  async cancelSlot(slotId: number, signal?: AbortSignal): Promise<void> {
    assertSlotId(slotId);
    await this.request(`/slots/${slotId}`, "DELETE", signal);
  }

  /**
   * Probe whether the server advertises the checkpoint endpoints. Hits
   * `/health` and looks for the upstream capability advertisement.
   * Conservative: returns `false` whenever the probe cannot prove support
   * (network error, unexpected JSON, no capability marker). The caller
   * should treat `false` as "feature off — run without rollback".
   */
  async probeSupported(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.request("/health", "GET", signal);
      const parsed = safeParseJson(response);
      if (parsed === null) return false;
      // Upstream `/health` returns a flat object; we look for either an
      // explicit feature flag or the `slot_save_path` field that mid-prefill
      // checkpoints require to be set. Either is sufficient evidence.
      if (typeof parsed !== "object") return false;
      const record = parsed as Record<string, unknown>;
      if (record.ctx_checkpoints_supported === true) return true;
      if (
        typeof record.slot_save_path === "string" &&
        record.slot_save_path.length > 0
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async request(
    path: string,
    method: "GET" | "POST" | "DELETE",
    signal?: AbortSignal,
  ): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const linkAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", linkAbort, { once: true });
      }
    }
    try {
      const response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new CheckpointHttpError(
          `[checkpoint-client] ${method} ${path} → ${response.status} ${response.statusText}`,
          response.status,
          body,
        );
      }
      return body;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", linkAbort);
    }
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function assertSlotId(slotId: number): void {
  if (!Number.isInteger(slotId) || slotId < 0) {
    throw new TypeError(
      `[checkpoint-client] invalid slotId: ${slotId} (must be a non-negative integer)`,
    );
  }
}

const CHECKPOINT_NAME_RE = /^[A-Za-z0-9._-]+$/;

function assertCheckpointName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    throw new TypeError(
      `[checkpoint-client] invalid checkpoint name: ${JSON.stringify(name)} (1-128 chars required)`,
    );
  }
  if (!CHECKPOINT_NAME_RE.test(name)) {
    throw new TypeError(
      `[checkpoint-client] invalid checkpoint name: ${JSON.stringify(name)} (allowed chars: A-Z a-z 0-9 . _ -)`,
    );
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const defaultFetch: CheckpointFetch = (input, init) =>
  globalThis.fetch(input, init);
