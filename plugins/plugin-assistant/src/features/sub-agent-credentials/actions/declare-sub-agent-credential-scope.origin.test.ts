/**
 * DECLARE_SUB_AGENT_CREDENTIAL_SCOPE through the real planner path and the
 * real credential bridge adapter: the owner request must carry the chat the
 * owner asked from, like the orchestrator credential route does. Without it a
 * `dm` request has no recipient and an `owner_app_inline` form has no room.
 *
 * The delivery adapters are deterministic transport ports. The `dm` port picks
 * its recipient like the Telegram DM adapter
 * (`channelId ?? requesterEntityId ?? originUserId`).
 */
import {
  ChannelType,
  createSensitiveRequestDispatchRegistry,
  type DispatchSensitiveRequest,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registerSubAgentCredentialBridgeAdapter } from "../credential-tunnel-service.ts";
import { subAgentCredentialsPlugin } from "../plugin.ts";

type Delivery = { request: DispatchSensitiveRequest; channelId?: string };

let runtime: ReturnType<typeof createSQLiteTestRuntime>;
let deliveries: Delivery[];
const ownerId = stringToUuid("declare-origin-owner") as UUID;
const roomId = stringToUuid("declare-origin-owner-dm") as UUID;
const worldId = stringToUuid("declare-origin-world") as UUID;

beforeEach(async () => {
  runtime = createSQLiteTestRuntime({
    character: { name: "Declare origin", bio: [] },
    logLevel: "fatal",
  });
  await runtime.initialize();
  deliveries = [];
  const dispatch = createSensitiveRequestDispatchRegistry();
  for (const target of ["dm", "owner_app_inline"] as const) {
    dispatch.register({
      target,
      supportsChannel: () => true,
      async deliver(args) {
        deliveries.push({ request: args.request, channelId: args.channelId });
        if (target === "owner_app_inline") {
          return { delivered: true, target, formRendered: true };
        }
        const recipient =
          args.channelId ??
          (args.request.requesterEntityId as string | null | undefined) ??
          (args.request.originUserId as string | undefined);
        return recipient
          ? { delivered: true, target, channelId: recipient }
          : {
              delivered: false,
              target,
              error:
                "No Telegram user id available (need targetChannelId or originUserId)",
            };
      },
    });
  }
  expect(
    registerSubAgentCredentialBridgeAdapter(runtime as IAgentRuntime, {
      dispatch,
      env: {},
    }),
  ).toBe(true);
  for (const action of subAgentCredentialsPlugin.actions ?? []) {
    runtime.registerAction(action);
  }

  // The owner talks to the agent in a Telegram DM (chat id 424242).
  await runtime.ensureConnection({
    entityId: ownerId,
    roomId,
    worldId,
    userName: "owner",
    source: "telegram",
    type: ChannelType.DM,
    channelId: "424242",
  });
  const world = await runtime.getWorld(worldId);
  if (!world) throw new Error("world missing");
  await runtime.updateWorld({
    ...world,
    metadata: {
      ...(world.metadata ?? {}),
      ownership: { ownerId },
      roles: { [ownerId]: "OWNER" },
    } as typeof world.metadata,
  });
});

afterEach(async () => {
  await runtime.stop();
  await runtime.close();
});

function ownerMessage(): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: ownerId,
    roomId,
    worldId,
    content: {
      text: "The coding agent needs my OpenAI key, ask me for it in a DM",
      source: "telegram",
      channelType: ChannelType.DM,
    },
  } as Memory;
}

function declare(params: Record<string, unknown>) {
  return executePlannedToolCall(
    runtime,
    {
      message: ownerMessage(),
      userRoles: ["OWNER"],
      activeContexts: ["code"],
    },
    { name: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE", params },
  );
}

it("delivers a dm request to the owner's chat it was declared from", async () => {
  const result = await declare({
    childSessionId: "pty-1-abc",
    credentialKeys: ["OPENAI_API_KEY"],
    deliveryTarget: "dm",
  });

  expect(deliveries).toHaveLength(1);
  const [sent] = deliveries;
  expect({
    channelId: sent.channelId,
    sourceRoomId: sent.request.sourceRoomId,
    ownerEntityId: sent.request.ownerEntityId,
    sourcePlatform: sent.request.sourcePlatform,
  }).toEqual({
    channelId: "424242",
    sourceRoomId: roomId,
    ownerEntityId: ownerId,
    sourcePlatform: "telegram",
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.data?.sensitiveRequestIds).toEqual([sent.request.id]);
});

it("gives the default owner-app form the owner's room and entity", async () => {
  const result = await declare({
    childSessionId: "pty-1-abc",
    credentialKeys: ["OPENAI_API_KEY"],
  });

  expect(deliveries).toHaveLength(1);
  const [sent] = deliveries;
  expect({
    sourceRoomId: sent.request.sourceRoomId,
    ownerEntityId: sent.request.ownerEntityId,
    sourcePlatform: sent.request.sourcePlatform,
  }).toEqual({
    sourceRoomId: roomId,
    ownerEntityId: ownerId,
    sourcePlatform: "owner_app",
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
});
