/** Connects a user-owned native messaging socket to one exact Chromium profile without browser replay. */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserTarget } from "./browser-service.js";
import { BrowserDispatchFailure } from "./dispatch-types.js";
import {
  acknowledgeNativeChunk,
  NativeMessageAssembler,
  NativeMessageSender,
} from "./native-wire.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "./workspace/browser-workspace-types.js";

export { commitFormHash } from "./commit-form-hash.js";

/** Label tone: the person acts, the assistant acts, an offer, or a host-confirmed success. */
export type NativeTaskGuideTone =
  | "instruction"
  | "active"
  | "offer"
  | "success";
/**
 * One tappable offer answer. Cards (two or three) show a value and its purpose;
 * at most one primary (Yes, only without cards) and one secondary (the decline).
 * Only `id` ever returns from the page.
 */
export interface NativeTaskGuideAnswer {
  id: string;
  kind: "card" | "primary" | "secondary";
  text: string;
  tag?: string;
}
/** Trusted host annotation request; deliberately absent from model browser actions. */
export type NativeTaskGuidance = {
  tabId: string;
  taskContext: NativeTaskContext;
  revision: number;
} & (
  | { kind: "hide" }
  /** Removes the label and answers; leaves a show-only paused cursor. */
  | { kind: "pause" }
  | {
      kind: "show";
      stepId: string;
      selector: string;
      text: string;
      detail?: string;
      tone?: NativeTaskGuideTone;
      /** Required exactly when `tone` is `"offer"`. */
      answers?: NativeTaskGuideAnswer[];
      expiresAt: number;
      restore?: boolean;
      /**
       * Snapshot references (same snapshot as `selector`) of controls the
       * label must not cover, for example the button the person presses next.
       */
      keepClear?: string[];
    }
);
/** A person's tap on a shown offer. It names the answer, never its value. */
export interface NativeTaskGuideAnswerEvent {
  tabId: string;
  stepId: string;
  revision: number;
  answerId: string;
}

const capabilities = new Set([
  "list",
  "open",
  "navigate",
  "snapshot",
  "click",
  "fill",
  "select",
  "scroll",
  "follow",
  "back",
  "forward",
  "reload",
  "close",
]);
export interface NativeTaskContext {
  actorId: string;
  accountId: string;
  agentId: string;
  taskId: string;
  epoch: number;
}
export interface NativeTaskBinding extends NativeTaskContext {
  tabId: string;
  bindingRevision: number;
  /** The origin of the page the binding starts on. */
  origin: string;
  /**
   * Every origin the bound page may be observed and acted on (2 to 16, `origin`
   * included), for a task the host extended. Requires the `task-origins` peer
   * capability. Absent: `origin` alone.
   */
  origins?: string[];
  expiresAt: number;
  revoked: boolean;
  /** Overlay display name (cursor tag and label mark). Defaults to "Eliza". */
  assistantName?: string;
  targets: Array<{
    selector: string;
    action: "click" | "fill" | "fill-code" | "select" | "scroll" | "follow";
  }>;
}
/** Longest life of a consented-commit grant, from the person's yes to its use. */
export const COMMIT_GRANT_MAX_MS = 60000;
/**
 * A host-issued, single-use grant for one commit (a submit, or a fill or
 * select that sends its form) the person explicitly said yes to. The host
 * issues it only after recording her yes to this exact step, control and
 * value. The browser checks every field, spends it once, and reports the
 * effect as a consented commit; without one, commits stay blocked.
 */
export interface NativeCommitGrant {
  /** Unique per yes; a spent ID is refused. */
  grantId: string;
  taskId: string;
  epoch: number;
  /** Must equal the task binding origin. Never crosses origins. */
  origin: string;
  /** The observed control (`<snapshotId>:0:<node>`): one page revision. */
  targetRef: string;
  /** The reviewed binding selector of the same control. */
  selector: string;
  subaction: "click" | "fill" | "select";
  /**
   * Lowercase hex SHA-256 of the exact fill/select text she approved.
   * Required for fill and select; not allowed on click.
   */
  valueHash?: string;
  /**
   * The one request this commit may send that is not the granted form's own
   * page load: a script ("Pay" posts with fetch), or a form whose page
   * handler sends it with fetch. `url` is an absolute https URL; `path` is
   * a path (and optional query) on the page's origin. Without it, the
   * granted submit button's form action and method are the only request
   * consented; for any other control no request is, and one is reported as
   * an effect violation. A page load of the granted form must match it too.
   * Fetch, XHR and beacon methods are not observable from the page, so the
   * page enforces the URL (and POST for a beacon); the method is still bound
   * into the grant the host issued.
   */
  requestTarget?: NativeCommitRequestTarget;
  /**
   * `commitFormHash` of the form data the host showed the person, in the
   * order the form sends it. The page consents a submit only when the
   * actual submission's form data (the submitter's name/value included)
   * hashes the same, so a field a script changed or added after her yes
   * stops it. Hosts doing money commits MUST send it. Without it, the
   * consented commit reports the submitted hash (`consentedCommit.formHash`,
   * left out for a form with a password, code or card field) to compare
   * after the fact.
   */
  formHash?: string;
  /** Epoch milliseconds, at most COMMIT_GRANT_MAX_MS ahead at use. */
  expiresAt: number;
}
/** The request a commit grant expects; exactly one of `url` and `path`. */
export type NativeCommitRequestTarget =
  | { url: string; path?: never; method: NativeCommitRequestMethod }
  | { path: string; url?: never; method: NativeCommitRequestMethod };
export type NativeCommitRequestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";
/** Shape check for a grant's `requestTarget`; the bridge applies the same. */
export function validCommitRequestTarget(
  target: unknown,
): target is NativeCommitRequestTarget {
  if (!target || typeof target !== "object" || Array.isArray(target))
    return false;
  const value = target as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    !keys.every((key) => ["url", "path", "method"].includes(key)) ||
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(
      value.method as string,
    ) ||
    "url" in value === "path" in value
  )
    return false;
  if ("path" in value)
    return (
      typeof value.path === "string" &&
      value.path.length <= 2048 &&
      /^\/(?!\/)[^\s#\\]*$/.test(value.path)
    );
  if (typeof value.url !== "string" || value.url.length > 2048) return false;
  try {
    const url = new URL(value.url);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !value.url.includes("#")
    );
  } catch {
    return false;
  }
}
/** Shape and scope checks shared by the trusted transports. */
export function validCommitGrant(
  grant: unknown,
  expected: {
    taskContext: NativeTaskContext;
    subaction: string;
    targetRef?: string;
    selector?: string;
    now: number;
  },
): grant is NativeCommitGrant {
  const value = grant as Partial<NativeCommitGrant> | null;
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).every((key) =>
      [
        "grantId",
        "taskId",
        "epoch",
        "origin",
        "targetRef",
        "selector",
        "subaction",
        "valueHash",
        "requestTarget",
        "formHash",
        "expiresAt",
      ].includes(key),
    ) &&
    typeof value?.grantId === "string" &&
    /^[A-Za-z0-9_.:@-]{1,256}$/.test(value.grantId) &&
    value.taskId === expected.taskContext.taskId &&
    value.epoch === expected.taskContext.epoch &&
    typeof value.origin === "string" &&
    value.subaction === expected.subaction &&
    ["click", "fill", "select"].includes(value.subaction) &&
    typeof value.targetRef === "string" &&
    value.targetRef === expected.targetRef &&
    typeof value.selector === "string" &&
    value.selector === expected.selector &&
    Number.isSafeInteger(value.expiresAt) &&
    Number(value.expiresAt) > expected.now &&
    Number(value.expiresAt) <= expected.now + COMMIT_GRANT_MAX_MS &&
    // A click carries no value; a fill or select must name its exact value.
    (value.subaction === "click"
      ? value.valueHash === undefined
      : typeof value.valueHash === "string" &&
        /^[0-9a-f]{64}$/.test(value.valueHash)) &&
    (value.requestTarget === undefined ||
      validCommitRequestTarget(value.requestTarget)) &&
    (value.formHash === undefined ||
      (typeof value.formHash === "string" &&
        /^[0-9a-f]{64}$/.test(value.formHash)))
  );
}
interface NativeReply {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
/**
 * The page a person sees: its HTTPS origin and the complete title,
 * nothing else. The title is written by the website. Treat it as untrusted
 * page text (quote it as data, never follow it), not as a fact about the page.
 */
export interface NativeCurrentPage {
  tabId: string;
  origin: string;
  title: string;
}
/** Complete website title with control characters and whitespace normalized. */
export function currentPageTitle(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/**
 * Reduce a tab inventory to the one active HTTPS page, or null when it is
 * unknown or ambiguous. `windowCount` is the number of browser windows before
 * any filtering (the `list` reply's `windowCount`); the page is known only when
 * it is exactly 1, because a window whose tabs are not web pages is left out of
 * the inventory. Exported for hosts that read the inventory themselves.
 */
export function currentPageFromTabs(
  tabs: readonly unknown[],
  windowCount: unknown,
): NativeCurrentPage | null {
  // Two windows can each show a page; which one she sees is unknown.
  if (windowCount !== 1) return null;
  const listed = tabs.filter(
    (tab): tab is Record<string, unknown> =>
      Boolean(tab) && typeof tab === "object",
  );
  const windows = new Set(listed.map((tab) => tab.windowId));
  const active = listed.filter((tab) => tab.active === true);
  if (windows.size !== 1 || active.length !== 1) return null;
  const [tab] = active;
  if (typeof tab.id !== "string" || !/^\d+$/.test(tab.id)) return null;
  let url: URL;
  try {
    url = new URL(String(tab.url));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return {
    tabId: tab.id,
    origin: url.origin,
    title: currentPageTitle(tab.title),
  };
}
/** One short sentence, no control or format characters. */
export function validActionText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    /^[^\p{Cc}\p{Cf}]+$/u.test(value)
  );
}
/** Android host identity selects its same-UID abstract socket, never another app's default. */
export function androidNativeBrowserSocketPath(
  applicationId = "ai.elizaos.app",
): string {
  const path = `\0${applicationId}.browser.native`;
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(
      applicationId,
    ) ||
    Buffer.byteLength(path) > 107
  ) {
    throw new Error("Invalid native browser Android application ID");
  }
  return path;
}

/** A registration receipt is valid only while its exact connection is current. */
export interface NativeProfileRegistration {
  profileId: string;
  isCurrent(): boolean;
}

export class NativeSocketBrowserTarget implements BrowserTarget {
  readonly id = "chromium-device";
  readonly name = "This device's Chromium";
  readonly description =
    "The registered native Chromium profile, including background tabs. Explicit tab IDs preserve the user's actual session.";
  readonly kind = "external" as const;
  readonly priority = 200;
  private socket: Socket | null = null;
  private server: Server | null = null;
  private sender: NativeMessageSender | null = null;
  private profileId: string | null = null;
  private advertised = new Set<string>();
  private pending = new Map<string, NativeReply>();
  private offers = new Map<
    string,
    { tabId: string; stepId: string; revision: number; answerIds: string[] }
  >();
  private answerListeners = new Set<
    (answer: NativeTaskGuideAnswerEvent) => void
  >();
  private registrationListeners = new Set<
    (registration: NativeProfileRegistration) => void | Promise<void>
  >();
  private stopped = false;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private lastTransportDiagnostic: string | null = null;
  private ownedPath: string | null = null;
  private androidSocketPath = androidNativeBrowserSocketPath();
  constructor(
    private readonly onDiagnostic: (error: Error) => void,
    private readonly liveness = { registrationMs: 30000, heartbeatMs: 90000 },
  ) {}

  private reportConnectionError(error: Error): void {
    if (this.stopped) return;
    const code = "code" in error ? String(error.code) : "";
    const unavailable =
      ["ECONNREFUSED", "ENOENT", "ECONNRESET"].includes(code) ||
      (error instanceof BrowserDispatchFailure && error.kind === "UNAVAILABLE");
    const diagnostic = unavailable ? "unavailable" : `${code}:${error.message}`;
    if (this.lastTransportDiagnostic === diagnostic) return;
    this.lastTransportDiagnostic = diagnostic;
    this.onDiagnostic(
      unavailable
        ? new BrowserDispatchFailure(
            "UNAVAILABLE",
            "The native Chromium transport is not connected.",
            { targetId: this.id, cause: error },
          )
        : error,
    );
  }
  available = async (): Promise<boolean> => this.getProfileId() !== null;
  supports = (command: BrowserWorkspaceCommand): boolean =>
    capabilities.has(command.subaction) &&
    this.advertised.has(command.subaction) &&
    (!command.id || /^\d+$/.test(command.id));
  /** Whether the registered profile advertised `capability`. False while no profile is registered. */
  hasCapability(capability: string): boolean {
    return this.advertised.has(capability);
  }
  getProfileId(): string | null {
    return !this.stopped && this.socket && !this.socket.destroyed
      ? this.profileId
      : null;
  }

  /** Trusted host lifecycle hook. Recheck isCurrent after asynchronous account reads.
   * Registration is not account authentication and grants no browser action. */
  onProfileRegistered(
    listener: (registration: NativeProfileRegistration) => void | Promise<void>,
  ): () => void {
    this.registrationListeners.add(listener);
    this.notifyRegistration(listener);
    return () => {
      this.registrationListeners.delete(listener);
    };
  }

  private notifyRegistration(
    listener: (registration: NativeProfileRegistration) => void | Promise<void>,
  ): void {
    const socket = this.socket;
    const profileId = this.getProfileId();
    if (!socket || !profileId) return;
    const isCurrent = () =>
      this.registrationListeners.has(listener) &&
      this.socket === socket &&
      this.getProfileId() === profileId;
    void Promise.resolve()
      .then(() => {
        if (isCurrent()) return listener({ profileId, isCurrent });
      })
      .catch((error) =>
        this.reportConnectionError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
  }

  /** Wait only for registration; no browser command is queued, retried or sent. */
  async waitForProfile(
    expectedProfileId: string,
    {
      timeoutMs = 10000,
      signal,
    }: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (
      typeof expectedProfileId !== "string" ||
      !expectedProfileId.trim() ||
      expectedProfileId.length > 256 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30000
    )
      throw new TypeError("Invalid native profile registration wait");
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const profile = this.getProfileId();
      if (this.stopped || (profile !== null && profile !== expectedProfileId))
        throw new BrowserDispatchFailure(
          "UNAVAILABLE",
          "Expected native profile unavailable.",
          { targetId: this.id },
        );
      if (profile === expectedProfileId) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new BrowserDispatchFailure(
          "UNAVAILABLE",
          "Native profile registration timed out.",
          { targetId: this.id },
        );
      await delay(Math.min(50, remaining), undefined, { signal });
    }
  }

  async start(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const android = [env.ELIZA_PLATFORM, env.ELIZA_MOBILE_PLATFORM].includes(
      "android",
    );
    if (android) {
      this.androidSocketPath = androidNativeBrowserSocketPath(
        env.ELIZA_BROWSER_ANDROID_APPLICATION,
      );
      this.connectAndroid();
      return;
    }
    const path =
      env.ELIZA_BROWSER_NATIVE_SOCKET ||
      (env.XDG_RUNTIME_DIR
        ? join(env.XDG_RUNTIME_DIR, "eliza", "browser-native.sock")
        : null);
    if (!path) return;
    if (!isAbsolute(path))
      throw new Error(
        "ELIZA_BROWSER_NATIVE_SOCKET must be an absolute local socket path.",
      );
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const directory = await stat(dirname(path));
    if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
      throw new Error(
        "Native browser socket directory must be private to the runtime user.",
      );
    const server = createServer((socket) => this.attach(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.ownedPath = path;
    await chmod(path, 0o600);
    server.on("error", (error) => this.onDiagnostic(error));
  }

  private connectAndroid(): void {
    if (this.stopped) return;
    const socket = createConnection({
      path: this.androidSocketPath,
    });
    socket.once("connect", () => this.attach(socket));
    socket.on("error", (error) => this.reportConnectionError(error));
    socket.once("close", () => {
      if (!this.stopped)
        this.reconnect = setTimeout(() => this.connectAndroid(), 3000);
    });
  }

  private attach(socket: Socket): void {
    if (this.socket) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    let buffer = Buffer.alloc(0);
    let deadline: ReturnType<typeof setTimeout>;
    const armDeadline = (milliseconds: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        this.reportConnectionError(
          new BrowserDispatchFailure(
            "UNAVAILABLE",
            "Native browser liveness deadline expired.",
            { targetId: this.id },
          ),
        );
        socket.destroy();
      }, milliseconds);
      deadline.unref();
    };
    armDeadline(this.liveness.registrationMs);
    const post = (frame: unknown) => {
      if (socket.destroyed) throw new Error("Native browser connection ended.");
      const body = Buffer.from(JSON.stringify(frame));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    };
    const sender = new NativeMessageSender(post);
    this.sender = sender;
    const assembler = new NativeMessageAssembler();
    socket.on("data", (chunk: Buffer) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (length > 64 * 1024 || length === 0)
            throw new Error("Invalid native browser frame length.");
          if (buffer.length < length + 4) break;
          const frame = JSON.parse(
            buffer.subarray(4, length + 4).toString("utf8"),
          );
          buffer = buffer.subarray(length + 4);
          if (sender.acceptAcknowledgement(frame)) continue;
          const message = assembler.accept(frame);
          acknowledgeNativeChunk(frame, post);
          if (message) {
            this.receive(message, post);
            const validated = message as Record<string, unknown>;
            if (validated.type === "hello") {
              clearTimeout(deadline);
              // Legacy peers without nonce support remain compatible; new peers
              // must demonstrate end-to-end liveness through regular pings.
              if (typeof validated.nonce === "string")
                armDeadline(this.liveness.heartbeatMs);
            } else if (validated.type === "ping")
              armDeadline(this.liveness.heartbeatMs);
          }
        }
      } catch (error) {
        // error-policy:J3 malformed native transport is disconnected before any partial result is used.
        this.onDiagnostic(
          error instanceof Error ? error : new Error(String(error)),
        );
        socket.destroy();
      }
    });
    socket.on("error", (error) => this.reportConnectionError(error));
    socket.once("close", () => {
      clearTimeout(deadline);
      if (this.socket !== socket) return;
      sender.close(new Error("Native browser transport disconnected."));
      this.sender = null;
      this.socket = null;
      this.profileId = null;
      this.advertised.clear();
      this.reportConnectionError(
        new BrowserDispatchFailure(
          "UNAVAILABLE",
          "The browser profile disconnected.",
          { targetId: this.id },
        ),
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new BrowserDispatchFailure(
            "UNCERTAIN_OUTCOME",
            "The native Chromium connection ended after dispatch; inspect the same profile before retrying.",
            { targetId: this.id },
          ),
        );
      }
      this.pending.clear();
      this.offers.clear();
    });
  }

  private receive(input: unknown, post: (frame: unknown) => void): void {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid native browser message.");
    const message = input as Record<string, unknown>;
    if (message.type === "hello") {
      if (
        this.profileId ||
        (message.nonce !== undefined &&
          (typeof message.nonce !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(message.nonce))) ||
        message.protocol !== 2 ||
        message.extensionId !== "pmldpcoefklbdbgmggcejkfoinmjfeio" ||
        typeof message.profileId !== "string" ||
        !Array.isArray(message.capabilities) ||
        !message.capabilities.every((value) => typeof value === "string")
      )
        throw new Error("Invalid native browser registration.");
      this.profileId = message.profileId;
      this.lastTransportDiagnostic = null;
      this.advertised = new Set(message.capabilities);
      if (typeof message.nonce === "string")
        post({
          type: "hello-ack",
          nonce: message.nonce,
          profileId: this.profileId,
        });
      for (const listener of this.registrationListeners)
        this.notifyRegistration(listener);
      return;
    }
    if (message.type === "ping") {
      if (
        !this.profileId ||
        message.profileId !== this.profileId ||
        typeof message.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(message.nonce)
      )
        throw new Error("Invalid native browser liveness probe.");
      post({ type: "pong", nonce: message.nonce, profileId: this.profileId });
      return;
    }
    if (message.type === "task-guide-answer") {
      this.acceptGuideAnswer(message);
      return;
    }
    if (
      !this.profileId ||
      message.type !== "result" ||
      typeof message.id !== "string"
    )
      throw new Error(
        "Native browser result arrived without profile registration.",
      );
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else {
      const error = message.error as
        | { kind?: string; message?: string }
        | undefined;
      const kind =
        error?.kind === "UNAVAILABLE"
          ? "UNAVAILABLE"
          : error?.kind === "STALE_REF"
            ? "STALE_REF"
            : error?.kind === "UNSUPPORTED"
              ? "UNSUPPORTED"
              : error?.kind === "POLICY_BLOCKED"
                ? "POLICY_BLOCKED"
                : "UNCERTAIN_OUTCOME";
      pending.reject(
        new BrowserDispatchFailure(
          kind,
          error?.message ?? "Native browser command failed.",
          { targetId: this.id },
        ),
      );
    }
  }

  private acceptGuideAnswer(message: Record<string, unknown>): void {
    if (
      !this.profileId ||
      !this.advertised.has("task-guide-label") ||
      Object.keys(message).sort().join(",") !==
        "answerId,id,revision,stepId,tabId,type" ||
      typeof message.id !== "string" ||
      typeof message.tabId !== "string" ||
      typeof message.stepId !== "string" ||
      typeof message.answerId !== "string" ||
      !Number.isSafeInteger(message.revision)
    )
      throw new Error("Invalid native browser guide answer.");
    const offer = this.offers.get(message.id);
    // An answer to a guide that was replaced, removed or already answered
    // no longer applies; it is dropped, never redirected.
    if (
      !offer ||
      offer.tabId !== message.tabId ||
      offer.stepId !== message.stepId ||
      offer.revision !== message.revision ||
      !offer.answerIds.includes(message.answerId)
    )
      return;
    this.offers.delete(message.id);
    const answer = {
      tabId: offer.tabId,
      stepId: offer.stepId,
      revision: offer.revision,
      answerId: message.answerId,
    };
    for (const listener of this.answerListeners) {
      try {
        listener(answer);
      } catch (error) {
        this.onDiagnostic(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  /**
   * Trusted host only: the page the person sees in this profile, reduced to its
   * HTTPS origin and the complete title (see currentPageTitle). The path,
   * query, fragment and the rest of the page never leave. The title is website
   * text, untrusted. Returns null when no single active HTTPS page is known: no
   * active web tab, more than one browser window (also one with no web page),
   * an extension that does not report its window count, or a non-HTTPS page.
   * This is an observation for conversation context. It is not a task binding
   * and grants no action on the page.
   */
  async currentPage(signal?: AbortSignal): Promise<NativeCurrentPage | null> {
    if (!this.supports({ subaction: "list" } as BrowserWorkspaceCommand))
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This Chromium profile cannot list its tabs.",
        { targetId: this.id },
      );
    const listing = await this.request(
      { subaction: "list" } as BrowserWorkspaceCommand,
      signal,
    );
    const { tabs, windowCount } =
      (listing as { tabs?: unknown; windowCount?: unknown } | null) ?? {};
    if (!Array.isArray(tabs))
      throw new Error("Invalid Chromium tab inventory.");
    // An extension that does not count windows cannot rule out another one.
    return currentPageFromTabs(tabs, windowCount);
  }

  /** Trusted host only: receives value-free offer answers from the bound page. */
  onTaskGuideAnswer(
    listener: (answer: NativeTaskGuideAnswerEvent) => void,
  ): () => void {
    this.answerListeners.add(listener);
    return () => this.answerListeners.delete(listener);
  }

  private request(
    command: BrowserWorkspaceCommand | undefined,
    signal?: AbortSignal,
    binding?: NativeTaskBinding,
    guidance?: NativeTaskGuidance,
    protection?: { owner: string | null },
  ): Promise<unknown> {
    const socket = this.socket;
    const sender = this.sender;
    if (signal?.aborted)
      return Promise.reject(
        new BrowserDispatchFailure(
          "STALE_REF",
          "The browser request was cancelled before dispatch.",
          { targetId: this.id },
        ),
      );
    if (signal && !this.advertised.has("cancel"))
      return Promise.reject(
        new BrowserDispatchFailure(
          "UNSUPPORTED",
          "This Chromium connection does not support cancellable requests.",
          { targetId: this.id },
        ),
      );
    if (!socket || !this.getProfileId() || !sender)
      return Promise.reject(
        new BrowserDispatchFailure(
          "UNAVAILABLE",
          "No registered Chromium profile is connected.",
          { targetId: this.id },
        ),
      );
    const id = randomUUID();
    if (guidance?.kind === "show" && guidance.answers)
      this.offers.set(id, {
        tabId: guidance.tabId,
        stepId: guidance.stepId,
        revision: guidance.revision,
        answerIds: guidance.answers.map((answer) => answer.id),
      });
    return new Promise((resolve, reject) => {
      const cancelRemote = () => {
        if (
          this.socket !== socket ||
          socket.destroyed ||
          !this.advertised.has("cancel")
        )
          return;
        // This is a best-effort fence, not proof that an already-dispatched effect
        // was undone. The caller still receives an uncertain outcome.
        void sender.send({ type: "cancel", id }).catch(() => socket.destroy());
      };
      const finish =
        (callback: (value: unknown) => void) => (value: unknown) => {
          signal?.removeEventListener("abort", abort);
          callback(value);
        };
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        cancelRemote();
        pending.reject(
          new BrowserDispatchFailure(
            "UNCERTAIN_OUTCOME",
            "The browser request was cancelled after dispatch; inspect the same tab without replaying it.",
            { targetId: this.id },
          ),
        );
      };
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        cancelRemote();
        pending.reject(
          new BrowserDispatchFailure(
            "UNCERTAIN_OUTCOME",
            "Chromium did not acknowledge the request before the deadline; inspect the same tab before retrying.",
            { targetId: this.id },
          ),
        );
      }, 30000);
      this.pending.set(id, {
        resolve: finish(resolve),
        reject: finish((error) => {
          this.offers.delete(id);
          reject(error);
        }),
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      void sender
        .send(
          binding
            ? { type: "task-bind", id, binding }
            : guidance
              ? { type: "task-guide", id, guidance }
              : protection
                ? { type: "protection-owner", id, owner: protection.owner }
                : { type: "command", id, command },
        )
        .catch((cause) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new BrowserDispatchFailure(
              "UNCERTAIN_OUTCOME",
              "The native command transport failed after dispatch; inspect the same profile before retrying.",
              { targetId: this.id, cause },
            ),
          );
          socket.destroy();
        });
    });
  }

  /** Trusted host account context, independent of any task. Never a model subaction.
   * Call after each registration and account transition; disconnect retires it.
   * The receipt counts page updates, not navigation or task permissions. */
  async setProtectionOwner(
    owner: string | null,
  ): Promise<{ updated: number; unavailable: number }> {
    if (
      owner !== null &&
      (typeof owner !== "string" || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(owner))
    )
      throw new TypeError("Invalid protection account context");
    if (!this.advertised.has("protection-owner"))
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This browser does not support account-scoped website advice.",
        { targetId: this.id },
      );
    const receipt = await this.request(
      undefined,
      undefined,
      undefined,
      undefined,
      { owner },
    );
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !("updated" in receipt) ||
      !("unavailable" in receipt) ||
      !Number.isSafeInteger(receipt.updated) ||
      !Number.isSafeInteger(receipt.unavailable) ||
      Number(receipt.updated) < 0 ||
      Number(receipt.unavailable) < 0
    )
      throw new BrowserDispatchFailure(
        "UNCERTAIN_OUTCOME",
        "Invalid website advice receipt.",
        { targetId: this.id },
      );
    return {
      updated: Number(receipt.updated),
      unavailable: Number(receipt.unavailable),
    };
  }

  /** Trusted host only: not exposed as a model browser subaction. */
  async bindTask(binding: NativeTaskBinding): Promise<unknown> {
    if (!this.advertised.has("task-bind"))
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This browser does not enforce task bindings.",
        { targetId: this.id },
      );
    if (binding.origins !== undefined && !this.advertised.has("task-origins"))
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This browser does not support a task with more than one website.",
        { targetId: this.id },
      );
    if (
      binding.assistantName !== undefined &&
      !this.advertised.has("task-guide-label")
    )
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This browser does not support a configured assistant name.",
        { targetId: this.id },
      );
    // Rebinding retires the old offer before any in-flight answer can arrive.
    for (const [id, offer] of this.offers)
      if (offer.tabId === binding.tabId) this.offers.delete(id);
    return this.request(undefined, undefined, binding);
  }

  /** Requires native task binding; this API is not a model-facing subaction. */
  async guideTask(
    guidance: NativeTaskGuidance,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.advertised.has("task-guide") || !this.advertised.has("task-bind"))
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This browser does not support task guidance.",
        { targetId: this.id },
      );
    if (
      (guidance.kind === "pause" ||
        (guidance.kind === "show" &&
          (guidance.detail !== undefined ||
            guidance.tone !== undefined ||
            guidance.answers !== undefined))) &&
      !this.advertised.has("task-guide-label")
    )
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This browser does not support guide labels, offers or pause.",
        { targetId: this.id },
      );
    if (
      guidance.kind === "show" &&
      guidance.keepClear !== undefined &&
      !this.advertised.has("task-guide-keep-clear")
    )
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This browser cannot keep controls clear of a guide label.",
        { targetId: this.id },
      );
    // Any new guide for the tab replaces its offer; late answers are dropped.
    for (const [id, offer] of this.offers)
      if (offer.tabId === guidance.tabId) this.offers.delete(id);
    return this.request(undefined, signal, undefined, guidance);
  }

  async execute(
    command: BrowserWorkspaceCommand,
    options: {
      signal?: AbortSignal;
      taskContext?: NativeTaskContext;
      taskExpiresAt?: number;
      protectedValueKind?: "verification-code";
      /** Host-written preview sentence for a bound task action. */
      actionText?: string;
      /** The one reviewed binding target (CSS selector) this action is for. */
      expectedSelector?: string;
      /** Host-issued grant for the one commit the person said yes to. */
      commitGrant?: NativeCommitGrant;
    } = {},
  ): Promise<BrowserWorkspaceCommandResult> {
    if (
      options.commitGrant !== undefined &&
      (!options.taskContext ||
        !this.advertised.has("task-commit-grant") ||
        !validCommitGrant(options.commitGrant, {
          taskContext: options.taskContext,
          subaction: command.subaction,
          targetRef: command.selector,
          selector: options.expectedSelector,
          now: Date.now(),
        }))
    )
      throw new BrowserDispatchFailure(
        "POLICY_BLOCKED",
        "A commit grant must match this bound task action and be current.",
        { targetId: this.id },
      );
    if (
      options.expectedSelector !== undefined &&
      (!options.taskContext ||
        !["click", "fill", "select", "scroll", "follow"].includes(
          command.subaction,
        ) ||
        typeof options.expectedSelector !== "string" ||
        !options.expectedSelector ||
        options.expectedSelector.length > 256 ||
        !this.advertised.has("task-expected-target"))
    )
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "A reviewed target needs a bound task action and a capable browser.",
        { targetId: this.id },
      );
    if (
      options.actionText !== undefined &&
      (!options.taskContext ||
        !["click", "fill", "select", "scroll", "follow"].includes(
          command.subaction,
        ) ||
        !validActionText(options.actionText))
    )
      throw new BrowserDispatchFailure(
        "POLICY_BLOCKED",
        "An action sentence needs a bound task action.",
        { targetId: this.id },
      );
    if (
      options.protectedValueKind &&
      (!options.taskContext ||
        command.subaction !== "fill" ||
        !this.advertised.has("task-protected-fill"))
    )
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "Protected fill requires a bound capable browser.",
        { targetId: this.id },
      );
    // Only trusted execute options may introduce this marker, never a raw command.
    const {
      protectedValueKind: _untrusted,
      actionText: _untrustedText,
      expectedSelector: _untrustedTarget,
      commitGrant: _untrustedGrant,
      ...safeCommand
    } = command as BrowserWorkspaceCommand & {
      protectedValueKind?: unknown;
      actionText?: unknown;
      expectedSelector?: unknown;
      commitGrant?: unknown;
    };
    command = safeCommand as BrowserWorkspaceCommand;
    if (
      options.taskContext &&
      ["click", "fill", "select", "scroll", "follow"].includes(
        command.subaction,
      ) &&
      !this.advertised.has("task-action-feedback")
    )
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "Task actions require a browser with action feedback.",
        { targetId: this.id },
      );
    if (
      options.taskContext &&
      (!command.id || !this.advertised.has("task-bind"))
    )
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "Task commands require an explicit tab and a binding-capable browser.",
        { targetId: this.id },
      );
    if (!this.supports(command))
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This Chromium profile does not support the requested command.",
        { targetId: this.id },
      );
    if (!command.id && !["open", "list"].includes(command.subaction)) {
      const listing = await this.request({ subaction: "list" }, options.signal);
      if (
        !listing ||
        typeof listing !== "object" ||
        !Array.isArray((listing as { tabs?: unknown }).tabs)
      )
        throw new Error("Invalid Chromium tab inventory.");
      const tabs = (
        listing as { tabs: Array<{ id?: unknown; active?: unknown }> }
      ).tabs.filter((tab) => tab.active === true && typeof tab.id === "string");
      if (tabs.length !== 1)
        throw new BrowserDispatchFailure(
          "UNSUPPORTED",
          "Select an explicit tab ID from list; the current profile has no unique active tab.",
          { targetId: this.id },
        );
      command = { ...command, id: String(tabs[0].id) };
    }
    if (command.subaction === "select" && command.text === undefined)
      command = { ...command, text: command.value };
    const profileId = this.profileId;
    const scopedCommand = options.taskContext
      ? {
          ...command,
          taskContext: options.taskContext,
          ...(options.protectedValueKind
            ? { protectedValueKind: options.protectedValueKind }
            : {}),
          ...(options.taskExpiresAt === undefined
            ? {}
            : { taskExpiresAt: options.taskExpiresAt }),
          ...(options.actionText === undefined
            ? {}
            : { actionText: options.actionText }),
          ...(options.expectedSelector === undefined
            ? {}
            : { expectedSelector: options.expectedSelector }),
          ...(options.commitGrant === undefined
            ? {}
            : { commitGrant: options.commitGrant }),
        }
      : command;
    const result = await this.request(scopedCommand, options.signal);
    return {
      targetId: this.id,
      mode: "desktop",
      subaction: command.subaction,
      value: { profileId, result },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.registrationListeners.clear();
    if (this.reconnect) clearTimeout(this.reconnect);
    this.socket?.destroy();
    if (this.server)
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    if (this.ownedPath) await rm(this.ownedPath, { force: true });
  }
}
