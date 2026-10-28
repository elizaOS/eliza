/** Host task transport for the selected embedded surface; no Chromium identity. */
import { randomUUID } from "node:crypto";
import {
  BROWSER_DISPATCH_FAILURE_KINDS,
  BrowserDispatchFailure,
  type BrowserDispatchFailureKind,
} from "./dispatch-types.js";
import {
  currentPageTitle,
  type NativeCurrentPage,
  type NativeSocketBrowserTarget,
  type NativeTaskBinding,
  type NativeTaskGuidance,
  validActionText,
  validCommitGrant,
} from "./native-socket-target.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "./workspace/browser-workspace-types.js";

export interface SurfaceCommandTransport {
  connectionId(): string | null;
  request(
    input: unknown,
    options: { signal?: AbortSignal; effect: boolean; connectionId?: string },
  ): Promise<unknown>;
}

export class NativeSurfaceBrowserTarget {
  readonly id = "native-embedded-surface";
  readonly advertised = new Set([
    "task-bind",
    "task-guide",
    "task-guide-label",
    "task-guide-keep-clear",
    "task-expected-target",
    "task-action-feedback",
    "task-origins",
    "task-commit-grant",
  ]);
  private stopped = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly channel: SurfaceCommandTransport) {}
  /** Compatibility with task hosts: this names a surface connection, never a Chromium profile. */
  getProfileId(): string | null {
    const id = this.stopped ? null : this.channel.connectionId();
    return id ? `embedded:${id}` : null;
  }
  // The owning host starts and stops the HTTP channel. This target owns no process.
  async start(): Promise<void> {
    if (this.stopped)
      throw this.fail("SESSION_GONE", "The embedded target was stopped.");
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
  }
  available = async (): Promise<boolean> => this.getProfileId() !== null;
  private fail(kind: BrowserDispatchFailureKind, message: string) {
    return new BrowserDispatchFailure(kind, message, { targetId: this.id });
  }
  private async send(
    message: Record<string, unknown>,
    effect: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    const connection = this.getProfileId();
    if (!connection)
      throw this.fail(
        "UNAVAILABLE",
        "The embedded page connection is unavailable.",
      );
    signal?.throwIfAborted();
    try {
      const result = await this.channel.request(
        { id: randomUUID(), ...message },
        { effect, signal, connectionId: connection.slice("embedded:".length) },
      );
      if (connection !== this.getProfileId() || signal?.aborted)
        throw this.fail(
          effect ? "UNCERTAIN_OUTCOME" : "STALE_REF",
          "The embedded page connection changed; observe without replaying.",
        );
      return result;
    } catch (error) {
      if (error instanceof BrowserDispatchFailure) throw error;
      const code = (error as { code?: unknown })?.code;
      const kind = BROWSER_DISPATCH_FAILURE_KINDS.includes(
        code as BrowserDispatchFailureKind,
      )
        ? (code as BrowserDispatchFailureKind)
        : effect
          ? "UNCERTAIN_OUTCOME"
          : "STALE_REF";
      throw new BrowserDispatchFailure(
        kind,
        "The embedded page command did not complete under its task context.",
        { targetId: this.id, cause: error },
      );
    }
  }
  async currentPage(): Promise<NativeCurrentPage | null> {
    const page = (await this.send({ type: "current-page" }, false)) as {
      tabId?: unknown;
      origin?: unknown;
      title?: unknown;
    } | null;
    if (page === null) return null;
    if (
      typeof page?.tabId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(page.tabId) ||
      typeof page.origin !== "string"
    )
      throw this.fail("STALE_REF", "The current embedded page is unknown.");
    const url = new URL(page.origin);
    if (url.protocol !== "https:" || url.origin !== page.origin)
      throw this.fail(
        "POLICY_BLOCKED",
        "The current embedded page must have an HTTPS origin.",
      );
    return {
      tabId: page.tabId,
      origin: url.origin,
      title: currentPageTitle(page.title),
    };
  }
  async bindTask(binding: NativeTaskBinding): Promise<unknown> {
    return this.send({ type: "task-bind", binding }, false);
  }
  async guideTask(
    guidance: NativeTaskGuidance,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      guidance.kind === "show" &&
      (guidance.answers !== undefined || guidance.tone === "offer")
    )
      throw this.fail(
        "UNSUPPORTED",
        "Approval controls belong in the trusted host.",
      );
    return this.send({ type: "task-guide", guidance }, false, signal);
  }
  async execute(
    command: BrowserWorkspaceCommand,
    options: Parameters<NativeSocketBrowserTarget["execute"]>[1] = {},
  ): Promise<BrowserWorkspaceCommandResult> {
    const effect = ["click", "fill", "select", "scroll", "follow"].includes(
      command.subaction,
    );
    if (
      !options.taskContext ||
      !command.id ||
      (!effect && command.subaction !== "snapshot") ||
      options.protectedValueKind !== undefined
    )
      throw this.fail(
        "UNSUPPORTED",
        "The embedded target requires a bound main-frame page command.",
      );
    if (
      options.commitGrant !== undefined &&
      !validCommitGrant(options.commitGrant, {
        taskContext: options.taskContext,
        subaction: command.subaction,
        targetRef: command.selector,
        selector: options.expectedSelector,
        now: Date.now(),
      })
    )
      throw this.fail(
        "POLICY_BLOCKED",
        "A commit grant must match this bound task action and be current.",
      );
    if (
      options.actionText !== undefined &&
      (!effect || !validActionText(options.actionText))
    )
      throw this.fail(
        "POLICY_BLOCKED",
        "The action preview must come from the trusted host.",
      );
    // Explicit fields prevent model/page data from introducing a task policy,
    // protected-value marker, validation bypass or action-ready identity.
    const scoped = {
      subaction: command.subaction,
      id: command.id,
      selector: command.selector,
      text:
        command.subaction === "select"
          ? (command.text ?? command.value)
          : command.text,
      direction: command.direction,
      taskContext: options.taskContext,
      taskExpiresAt: options.taskExpiresAt,
      expectedSelector: options.expectedSelector,
      actionText: options.actionText,
      commitGrant: options.commitGrant,
    };
    const profileId = this.getProfileId();
    const result = await this.send(
      { type: "command", command: scoped },
      effect,
      options.signal,
    );
    return {
      targetId: this.id,
      mode: "desktop",
      subaction: command.subaction,
      value: { profileId, result },
    };
  }
}
