import type { SessionId } from "@agentclientprotocol/sdk";
import { createRoomElizaId, type SessionIdentity } from "./lib/identity.js";
import type { ChatRoom } from "./types.js";

export interface AcpSessionState {
  room: ChatRoom;
  cwd?: string;
  manualInjected: boolean;
}

export function createAcpSessionState(
  sessionId: SessionId,
  identity: SessionIdentity,
  cwd?: string,
): AcpSessionState {
  return {
    room: {
      id: sessionId,
      name: "acp",
      messages: [],
      createdAt: new Date(),
      taskIds: [],
      // Derive the room from the session even though process admission is
      // single-session. This prevents reuse across future transports or tests
      // from silently merging runtime memory, cwd, and tool context.
      elizaRoomId: createRoomElizaId(identity),
    },
    cwd,
    manualInjected: false,
  };
}

export type AcpTurnResult<T> =
  | { cancelled: false; value: T }
  | { cancelled: true };

/**
 * One ACP child owns one workspace for its entire process lifetime. The
 * coding runtime and bubblewrap roots are process-scoped, so admitting a
 * second session would either deny its shell access or broaden both sessions'
 * authority. Concurrency is provided by spawning independent ACP children.
 */
export class AcpSessionAdmission {
  private reservedSessionId: SessionId | undefined;

  reserve(sessionId: SessionId): void {
    if (this.reservedSessionId !== undefined) {
      throw new Error(
        `[eliza-code-acp] process already reserved for session ${this.reservedSessionId}`,
      );
    }
    this.reservedSessionId = sessionId;
  }
}

interface ActiveTurn {
  controller: AbortController;
  settled: Promise<void>;
  markSettled: () => void;
}

/**
 * Owns the one in-flight turn allowed for each ACP session and carries client
 * cancellation into the Eliza message service through an AbortSignal.
 */
export class AcpTurnRegistry {
  private readonly active = new Map<SessionId, ActiveTurn>();

  async run<T>(
    sessionId: SessionId,
    operation: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<AcpTurnResult<T>> {
    if (this.active.has(sessionId)) {
      throw new Error(
        `[eliza-code-acp] session ${sessionId} already has an active prompt`,
      );
    }

    const controller = new AbortController();
    let markSettled = (): void => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const activeTurn = { controller, settled, markSettled };
    this.active.set(sessionId, activeTurn);
    try {
      const value = await operation(controller.signal);
      return controller.signal.aborted
        ? { cancelled: true }
        : { cancelled: false, value };
    } catch (error) {
      if (controller.signal.aborted) return { cancelled: true };
      throw error;
    } finally {
      if (this.active.get(sessionId) === activeTurn) {
        this.active.delete(sessionId);
      }
      activeTurn.markSettled();
    }
  }

  cancel(sessionId: SessionId): boolean {
    const activeTurn = this.active.get(sessionId);
    if (!activeTurn) return false;
    activeTurn.controller.abort(
      new DOMException("ACP session cancelled by client", "AbortError"),
    );
    return true;
  }

  async cancelAndWait(
    sessionId: SessionId,
    timeoutMs: number,
  ): Promise<boolean> {
    const activeTurn = this.active.get(sessionId);
    if (!activeTurn) return false;
    this.cancel(sessionId);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        activeTurn.settled,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `[eliza-code-acp] session ${sessionId} did not quiesce within ${timeoutMs}ms after cancellation`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    return true;
  }

  /** Abort every in-flight turn synchronously, then wait for one shared
   * quiescence deadline. Used when the ACP stdio connection itself disappears:
   * no session-specific cancellation request can arrive after EOF. */
  async cancelAllAndWait(timeoutMs: number): Promise<number> {
    const activeTurns = [...this.active.values()];
    if (activeTurns.length === 0) return 0;
    for (const activeTurn of activeTurns) {
      activeTurn.controller.abort(
        new DOMException("ACP connection closed by client", "AbortError"),
      );
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(activeTurns.map((activeTurn) => activeTurn.settled)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `[eliza-code-acp] ${activeTurns.length} active turn${
                    activeTurns.length === 1 ? "" : "s"
                  } did not quiesce within ${timeoutMs}ms after connection close`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    return activeTurns.length;
  }

  hasActiveTurn(sessionId: SessionId): boolean {
    return this.active.has(sessionId);
  }
}
