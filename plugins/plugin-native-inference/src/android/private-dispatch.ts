import type { IAgentRuntime } from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/host/protocol";
import { createStdioBridge } from "../shared/stdio-bridge.ts";
import {
  type AndroidCoreRouteDeps,
  type AndroidDispatchRoute,
  type AndroidRequestPayload,
  dispatchBufferedRequest,
  dispatchStreamingRequest,
} from "./dispatch.ts";
import {
  resolveAgentEventBus,
  serveAgentEventSubscription,
} from "./event-subscription.ts";
import { startPrivateServer } from "./private-ipc.ts";
/** Transport closure does not promise dispatcher cancellation or effect rollback. */
export function startLocalAgentServer(
  runtime: IAgentRuntime,
  dispatchRoute: AndroidDispatchRoute,
  coreRoutes?: AndroidCoreRouteDeps,
  env = process.env,
  policy: { transportDeadlineMs?: number } = {},
) {
  return startPrivateServer(
    async (frame, connection) => {
      const bridge = createStdioBridge({
        request: async (value) =>
          dispatchBufferedRequest(
            runtime,
            dispatchRoute,
            (value.payload ?? {}) as AndroidRequestPayload,
            coreRoutes,
          ),
        requestStream: async (value, sink) =>
          dispatchStreamingRequest(
            runtime,
            dispatchRoute,
            (value.payload ?? {}) as AndroidRequestPayload,
            sink,
            coreRoutes,
          ),
        writeFrame: (value) => connection.write(value),
      });
      await bridge.handleLine(JSON.stringify(frame));
    },
    env,
    policy,
    {
      // Live agent events (e.g. ephemeral `voice-transcript`) for the
      // port-free app; see event-subscription.ts for the wire contract.
      subscribe: (frame, connection) =>
        serveAgentEventSubscription({
          frame,
          connection,
          bus: resolveAgentEventBus(runtime),
          expectedToken:
            env === process.env
              ? readAliasedEnv("ELIZA_API_TOKEN")
              : env.ELIZA_API_TOKEN,
          ephemeralStreams: coreRoutes?.ephemeralAgentEventStreams,
        }),
    },
  );
}
