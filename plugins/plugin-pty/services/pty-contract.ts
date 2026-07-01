/**
 * Structural contract the agent server consumes when it looks up the
 * `PTY_SERVICE` (`runtime.getService("PTY_SERVICE") as PTYService`) to drive the
 * web terminal over WebSocket.
 *
 * ⚠️ This MUST stay structurally in sync with the canonical definition in
 * `packages/agent/src/api/parse-action-block.ts` (`ConsoleBridge` / `PTYService`).
 * We redeclare it here — rather than import from `@elizaos/agent` — because
 * `@elizaos/agent` depends on the plugin set, so a plugin importing it would
 * create a dependency cycle. The runtime binds these two structurally at the
 * `getService` cast, exactly as designed for decoupled service contracts.
 *
 * The agent server (packages/agent/src/api/server.ts) drives the bridge like so:
 *   bridge.on("session_output", (evt: { sessionId, data }) => ws.send(...))   // pty-subscribe
 *   bridge.writeRaw(sessionId, data)                                          // pty-input
 *   bridge.resize(sessionId, cols, rows)                                      // pty-resize
 *   bridge.off("session_output", listener)                                    // pty-unsubscribe
 */

/** Console bridge exposed by the PTY service for terminal I/O. */
export interface ConsoleBridge {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  writeRaw(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
}

/** The `session_output` event payload the agent server subscribes to. */
export interface SessionOutputEvent {
  sessionId: string;
  data: string;
}

/** The `session_exit` event payload (emitted when a session's process ends). */
export interface SessionExitEvent {
  sessionId: string;
  exitCode: number | null;
}
