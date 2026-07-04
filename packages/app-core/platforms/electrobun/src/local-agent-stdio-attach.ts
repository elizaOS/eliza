/**
 * Wires the agent child's stdio pipe to a {@link LocalAgentStdioDispatcher} and
 * registers it as the process-wide active dispatcher (#12180 / #12355).
 *
 * Called from the agent-child spawn path only in local-agent IPC mode
 * (`ELIZA_DESKTOP_LOCAL_AGENT_IPC=1`, `localAgentMode` on the child). The child
 * binds no TCP listener; the renderer's `localAgentRequest` RPC calls ride this
 * dispatcher over the NDJSON stdio frames instead. `detach()` (on child exit /
 * shutdown) rejects every in-flight request and clears the registry so a
 * subsequent request fails loudly rather than hanging on a dead pipe.
 *
 * The child multiplexes its human-readable logs on the same stdout pipe, so the
 * line pump forwards every line to the dispatcher, which ignores anything that
 * is not a JSON response frame keyed by a pending request id.
 */

import { setActiveLocalAgentDispatcher } from "./local-agent-dispatcher-registry";
import {
  LocalAgentStdioDispatcher,
  type StdioFrameWriter,
} from "./local-agent-stdio-dispatcher";

/** The child stdio surface this attach helper needs. */
export interface LocalAgentChildStdio {
  /** Child stdin — request frames are written here as NDJSON lines. */
  stdin: StdioFrameWriter;
  /** Child stdout — response frames (and logs) arrive here line by line. */
  stdout: AsyncIterable<string>;
}

export interface LocalAgentStdioAttachment {
  dispatcher: LocalAgentStdioDispatcher;
  /** Tear down: reject in-flight requests, clear the registry. Idempotent. */
  detach: (reason: string) => void;
}

/**
 * Attach `child` to a fresh dispatcher, register it, and start pumping stdout
 * lines into it. The stdout pump runs until the iterable ends or `detach` is
 * called; a pump failure (pipe error) tears the attachment down with the error.
 */
export function attachLocalAgentStdioBridge(
  child: LocalAgentChildStdio,
): LocalAgentStdioAttachment {
  const dispatcher = new LocalAgentStdioDispatcher(child.stdin);
  setActiveLocalAgentDispatcher(dispatcher);

  let detached = false;
  const detach = (reason: string): void => {
    if (detached) return;
    detached = true;
    dispatcher.dispose(reason);
    setActiveLocalAgentDispatcher(null);
  };

  void (async () => {
    try {
      for await (const line of child.stdout) {
        if (detached) return;
        dispatcher.handleLine(line);
      }
      detach("agent child stdout closed");
    } catch (err) {
      detach(
        `agent child stdout errored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  return { dispatcher, detach };
}
