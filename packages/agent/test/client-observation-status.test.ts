import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  CLIENT_TURN_OBSERVATION_SUPPORT,
  readClientTurnObservationPeerSupport,
  readClientTurnObservationSupport,
} from "@elizaos/contracts/client-turn-observation";
import { expect, it } from "vitest";
import {
  type HealthRouteState,
  handleHealthRoutes,
} from "../src/api/health-routes.ts";
import { getPairingInstanceId } from "../src/api/server-helpers-auth.ts";

it("publishes format support through the existing status route without declaring action access", async () => {
  const req = new IncomingMessage(new Socket()),
    res = new ServerResponse(req);
  const state: HealthRouteState = {
    runtime: null,
    config: {},
    agentState: "stopped",
    agentName: "fixture",
    model: undefined,
    startedAt: undefined,
    startup: { phase: "fixture", attempt: 0 },
    plugins: [],
    pendingRestartReasons: [],
    connectorHealthMonitor: null,
  };
  let output: unknown;
  try {
    expect(
      await handleHealthRoutes({
        req,
        res,
        method: "GET",
        pathname: "/api/status",
        url: new URL("http://127.0.0.1/api/status"),
        state,
        json: (_res, value) => {
          output = value;
        },
        error: () => {
          throw Error("Unexpected status failure");
        },
      }),
    ).toBe(true);
    const payload = output as Record<string, unknown>;
    expect(
      readClientTurnObservationSupport(payload.clientTurnObservationSupport),
    ).toEqual(CLIENT_TURN_OBSERVATION_SUPPORT);
    expect(payload.serverInstanceId).toBe(getPairingInstanceId());
    expect(
      readClientTurnObservationPeerSupport(payload, getPairingInstanceId()),
    ).toEqual(CLIENT_TURN_OBSERVATION_SUPPORT);
    expect(payload.deviceActionRegistration).toBe("runtime_unavailable");
    expect(payload.canRespond).toBe(false);
    expect(payload).not.toHaveProperty("calendarPermission");
    expect(Object.keys(payload.clientTurnObservationSupport as object)).toEqual(
      ["version", "optionalFields"],
    );
  } finally {
    req.destroy();
    res.destroy();
  }
});
