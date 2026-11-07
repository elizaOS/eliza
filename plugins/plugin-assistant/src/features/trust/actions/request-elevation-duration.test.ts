/**
 * request_elevation takes hours. The permission service stores seconds, so
 * `hours * 60 * 1000` granted one minute per requested hour and then the
 * service multiplied by 1000 again.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import type { ElevationRequest } from "../types/permissions.ts";
import { requestElevationHandler } from "./requestElevation.ts";

const message = {
  id: "message-id",
  entityId: "entity-id",
  roomId: "room-id",
  content: { text: "" },
} as Memory;

async function requestedDuration(
  duration?: number,
): Promise<number | undefined> {
  let captured: ElevationRequest | undefined;
  const runtime = {
    agentId: "agent-id",
    getService: (name: string) => {
      if (name === "trust-engine") {
        return { trustEngine: { evaluateTrust: async () => ({}) } };
      }
      if (name === "contextual-permissions") {
        return {
          permissionSystem: {
            requestElevation: async (request: ElevationRequest) => {
              captured = request;
              return { granted: false, reason: "test" };
            },
          },
        };
      }
      return null;
    },
  } as unknown as IAgentRuntime;

  await requestElevationHandler(runtime, message, {} as State, {
    parameters: {
      permissionAction: "manage_roles",
      ...(duration === undefined ? {} : { duration }),
    },
  });
  return captured?.duration;
}

describe("request_elevation duration", () => {
  test("stores one requested hour as 3600 seconds", async () => {
    expect(await requestedDuration(1)).toBe(60 * 60);
  });

  test("stores the 60 hour default as seconds when duration is omitted", async () => {
    expect(await requestedDuration()).toBe(60 * 60 * 60);
  });

  test("stores the one-week maximum as seconds", async () => {
    expect(await requestedDuration(168)).toBe(168 * 60 * 60);
  });
});
