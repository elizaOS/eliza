import type { IAgentRuntime } from "@elizaos/core";
import { createStdioBridge } from "../shared/stdio-bridge.ts";
import {
  type AndroidCoreRouteDeps,
  type AndroidDispatchRoute,
  type AndroidRequestPayload,
  dispatchBufferedRequest,
  dispatchStreamingRequest,
} from "./dispatch.ts";
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
  );
}
