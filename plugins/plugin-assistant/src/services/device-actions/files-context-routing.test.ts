import { AgentRuntime, type Memory } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { collectV5PlannerCandidateActions } from "../message/action-surface.ts";
import { offeredDeviceOperations, proposeDeviceAction } from "./action.ts";
import { FILES_CAPABILITY } from "./files-browser-contract.ts";
import { DeviceActionService, withDeviceActionTurn } from "./service.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const room = "22222222-2222-4222-8222-222222222222";
afterEach(() => vi.restoreAllMocks());

function phone() {
  const runtime = new AgentRuntime({
    character: {
      name: "Eliza",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtime.contexts.tryRegisterMany(DEFAULT_CONTEXT_DEFINITIONS);
  vi.spyOn(runtime, "getRoom").mockResolvedValue({ worldId: "world" } as never);
  vi.spyOn(runtime, "getWorld").mockResolvedValue({
    id: "world",
    metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
  } as never);
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  runtime.registerAction(proposeDeviceAction);
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: {
      text: "Show my PDFs in Files.",
      source: "client_chat",
      channelType: "DM",
    },
  } as Memory;
  return { runtime, message };
}

const admittedFor = (
  runtime: AgentRuntime,
  message: Memory,
  selectedContexts: string[],
) =>
  withDeviceActionTurn(
    runtime,
    {
      subjectUserId: "owner-subject",
      installationId: "installation",
      deviceKey: "device-key",
      capabilities: ["device.proposals.v1", FILES_CAPABILITY],
    },
    async () =>
      (
        await collectV5PlannerCandidateActions({
          runtime,
          message,
          state: { text: "", values: {}, data: {} },
          selectedContexts,
          candidateActions: [],
          intents: [],
          userRoles: ["OWNER"],
        })
      ).map((action) => action.name),
    {
      requestCaller: {
        subjectUserId: "owner-subject",
        entityId: owner,
        role: "OWNER",
      },
    },
  );

// A phone negotiated files.browser.v1 and the owner asked for PDFs in Files.
// The first stage routed it as a files task, where the planner was offered
// attachment and knowledge tools and no way to open the phone's Files.
it("reaches the phone's Files operations from a request routed as a files task", async () => {
  const { runtime, message } = phone();
  expect(await admittedFor(runtime, message, ["files"])).toContain(
    "PROPOSE_DEVICE_ACTION",
  );
  const types = offeredDeviceOperations(proposeDeviceAction, [
    "device.proposals.v1",
    FILES_CAPABILITY,
  ]).flatMap((branch) => branch.properties?.type?.enum ?? []);
  expect(types).toContain("files_filter");
  expect(types).toContain("files_open");
});

it("stays out of a context none of its operations belongs to", async () => {
  const { runtime, message } = phone();
  expect(await admittedFor(runtime, message, ["finance"])).not.toContain(
    "PROPOSE_DEVICE_ACTION",
  );
});
