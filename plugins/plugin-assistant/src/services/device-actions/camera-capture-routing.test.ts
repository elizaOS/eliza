import {
  type Action,
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  getDirectActionRoutingRules,
  type Memory,
  promoteSubactionsToActions,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { viewsAction } from "../../../../../packages/agent/src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
} from "../../../../../packages/agent/src/api/views-registry.ts";
import {
  viewNavigationEvaluator,
  viewNavigationField,
} from "../../../../../packages/agent/src/runtime/view-navigation.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { collectV5PlannerCandidateActions } from "../message/action-surface.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../message/stage1-evaluators.ts";
import { deviceActionForCapabilities, proposeDeviceAction } from "./action.ts";
import { authoredCameraCapture } from "./camera-request.ts";
import {
  DeviceActionService,
  deviceActionToolGuidance,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "./service.ts";
import {
  deviceActionTools,
  registerDeviceCameraCaptureRouting,
} from "./tools.ts";

// The v609 phone negotiated both; "take a picture" still only opened Camera.
const CAMERA = ["camera.capture-photo.v1", "camera.capture-lens.v1"];
const owner = "11111111-1111-4111-8111-111111111111",
  room = "22222222-2222-4222-8222-222222222222";
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});
const camera = deviceActionTools.find(
  (a) => a.name === "DEVICE_CAMERA_CAPTURE",
);
if (!camera) throw new Error("Expected the camera capture tool");
const ownerCaller = (subjectUserId: string) => ({
  requestCaller: { subjectUserId, entityId: owner, role: "OWNER" },
});

async function fixture(request = "take a picture", capabilities = CAMERA) {
  const runtime = new AgentRuntime({
    character: {
      name: "Eliza",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  runtime.contexts.tryRegisterMany(DEFAULT_CONTEXT_DEFINITIONS);
  vi.spyOn(runtime, "getRoom").mockResolvedValue({ worldId: "world" } as never);
  vi.spyOn(runtime, "getWorld").mockResolvedValue({
    id: "world",
    metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
  } as never);
  vi.spyOn(runtime, "getEntityById").mockResolvedValue(null);
  vi.spyOn(runtime, "getParticipantsForRoom").mockResolvedValue([
    owner,
    runtime.agentId,
  ]);
  for (const action of [
    camera as Action,
    proposeDeviceAction,
    ...promoteSubactionsToActions(viewsAction),
  ])
    runtime.registerAction(action);
  registerBuiltinViews(runtime);
  registerDeviceCameraCaptureRouting(runtime);
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: {
      text: request,
      source: "client_chat",
      channelType: "DM",
      metadata: {
        clientDevice: {
          context: { view: "maps", revision: 19, sensitive: false },
        },
        viewClientId: "test-renderer",
        viewDelivery: "completed-action",
        uiView: "chat",
      },
    },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  const credential = {
    subjectUserId: "owner-subject",
    installationId: "installation",
    deviceKey: "device-key",
    capabilities,
  };
  const rule = getDirectActionRoutingRules(runtime).find(
    (r) => r.id === "device.camera-capture",
  );
  if (!rule) throw new Error("Expected the camera capture route");
  return { runtime, message, credential, rule };
}

it.each([
  "take a picture",
  "Take a photo.",
  "take a pic",
  "snap a photo",
  "please take a picture",
  "Hey Eliza, take a selfie!",
  "take a picture with the front camera",
  "take a photo using the back camera please",
  "take a picture of me",
  "capture a photo now",
])(
  "replaces the v609 view-only plan with the capture tool: %s",
  async (request) => {
    const f = await fixture(request);
    await withDeviceActionTurn(
      f.runtime,
      f.credential,
      async () => {
        setDeviceActionRequestMessage(f.runtime, f.message);
        expect(f.rule.matches(request, f.message)).toBe(true);
        expect(f.rule.wholeRequest?.matches(request, f.message)).toBe(true);
        // The exact Stage-1 plan the phone produced for "take a picture".
        const handler = {
          processMessage: "RESPOND",
          plan: {
            contexts: ["general"],
            intents: ["capture a photo"],
            candidateActions: ["VIEWS_SHOW"],
            parentActionHints: [],
            requiresTool: true,
            replyEffectStatus: "pending",
            reply: "Let me open Camera for you.",
          },
        };
        const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
          (e) => e.name === "core.direct_registered_capability_request",
        );
        if (!evaluator) throw new Error("Expected capability evaluator");
        const result = await runResponseHandlerEvaluators({
          runtime: f.runtime,
          message: f.message,
          state: { text: "", values: {}, data: {} },
          messageHandler: handler,
          availableContexts: DEFAULT_CONTEXT_DEFINITIONS,
          userRoles: ["OWNER"],
          evaluators: [evaluator],
        } as never);
        expect(handler.plan.candidateActions).toEqual([
          "DEVICE_CAMERA_CAPTURE",
        ]);
        expect(handler.plan.intents).toEqual([request]);
        expect(result.appliedPatches.flatMap((p) => p.changed)).toContain(
          "intentField:invalidate:visualContinuation",
        );
        const admitted = await collectV5PlannerCandidateActions({
          runtime: f.runtime,
          message: f.message,
          state: { text: "", values: {}, data: {} },
          selectedContexts: handler.plan.contexts,
          candidateActions: handler.plan.candidateActions,
          intents: handler.plan.intents,
          userRoles: ["OWNER"],
        });
        expect(admitted.map((a) => a.name)).toContain("DEVICE_CAMERA_CAPTURE");
        expect(handler.plan).not.toHaveProperty("deterministicToolCall");
      },
      ownerCaller(f.credential.subjectUserId),
    );
  },
);

it("keeps the invalidated navigation judgment from running Camera navigation alone", async () => {
  const f = await fixture();
  if (!viewNavigationField.handle)
    throw new Error("Expected navigation field handler");
  viewNavigationField.handle({
    runtime: f.runtime,
    message: f.message,
    senderRole: "OWNER",
    value: {
      disposition: "direct",
      viewId: "camera",
      reason:
        "User asked to take a picture; opening the Camera view satisfies the entire request.",
    },
    turnSignal: new AbortController().signal,
  } as never);
  const result = await viewNavigationEvaluator.evaluate({
    runtime: f.runtime,
    message: f.message,
    state: { data: { providers: {} } },
    userRoles: ["OWNER"],
    invalidatedScopeFields: new Set(["visualContinuation"]),
    messageHandler: {
      processMessage: "RESPOND",
      plan: {
        contexts: ["general"],
        intents: ["take a picture"],
        candidateActions: ["DEVICE_CAMERA_CAPTURE"],
        parentActionHints: [],
        requiresTool: true,
        replyEffectStatus: "pending",
      },
    },
  } as never);
  expect(result).toBeUndefined();
});

it("tells the first-stage judge that using a view's function is not opening it", () => {
  expect(viewNavigationField.description).toContain(
    "opening Camera takes no photo",
  );
});

it.each([
  "open the camera",
  "Camera",
  "can you take a picture?",
  "take a picture tomorrow",
  "don't take a picture",
  "take a picture of the receipt and send it to Sam",
  "how do I take a picture?",
  "I took a picture yesterday",
  "take a picture with the front camera with the back camera",
  "take a shot",
  "take a picture\nof this",
])(
  "leaves non-strict or compound phrasing to the planner: %s",
  async (request) => {
    const f = await fixture(request);
    await withDeviceActionTurn(
      f.runtime,
      f.credential,
      async () => {
        setDeviceActionRequestMessage(f.runtime, f.message);
        expect(f.rule.matches(request, f.message)).toBe(false);
      },
      ownerCaller(f.credential.subjectUserId),
    );
  },
);

it("requires the bound owner turn and the negotiated capture capability", async () => {
  const f = await fixture("take a picture", ["clock.handoff.v1"]);
  expect(f.rule.matches("take a picture", f.message)).toBe(false);
  await withDeviceActionTurn(
    f.runtime,
    f.credential,
    async () => {
      setDeviceActionRequestMessage(f.runtime, f.message);
      expect(f.rule.matches("take a picture", f.message)).toBe(false);
    },
    ownerCaller(f.credential.subjectUserId),
  );
  const g = await fixture();
  await withDeviceActionTurn(
    g.runtime,
    g.credential,
    async () => {
      // A non-owner caller cannot bind the request message at all.
      expect(() =>
        setDeviceActionRequestMessage(g.runtime, g.message),
      ).toThrow();
      expect(g.rule.matches("take a picture", g.message)).toBe(false);
    },
    {
      requestCaller: {
        subjectUserId: g.credential.subjectUserId,
        entityId: owner,
        role: "USER",
      },
    },
  );
});

it("reads the named lens from the owner's words", () => {
  expect(authoredCameraCapture("take a picture")).toEqual({});
  expect(authoredCameraCapture("take a selfie")).toEqual({ lens: "front" });
  expect(authoredCameraCapture("take a picture of me")).toEqual({
    lens: "front",
  });
  expect(
    authoredCameraCapture("take a photo with the rear camera, please"),
  ).toEqual({ lens: "back" });
  expect(
    authoredCameraCapture("take a selfie with the back camera"),
  ).toBeUndefined();
  expect(authoredCameraCapture("Luna, take a picture", "Luna")).toEqual({});
  expect(authoredCameraCapture("Luna, take a picture")).toBeUndefined();
});

it("offers the camera tool exactly one capture form per phone", () => {
  const forms = (capabilities: string[]) =>
    deviceActionForCapabilities(camera, capabilities)
      .parameters?.find((p) => p.name === "operation")
      ?.schema.anyOf?.map((branch) => Object.keys(branch.properties ?? {}));
  expect(forms(CAMERA)).toEqual([["type", "lens"]]);
  expect(forms(["camera.capture-photo.v1"])).toEqual([["type"]]);
  // The registered tool keeps both; only a turn's scoped copy narrows it.
  expect(
    camera.parameters?.find((p) => p.name === "operation")?.schema.anyOf,
  ).toHaveLength(2);
  expect(camera.descriptionCompressed).toContain("photo");
  expect(camera.contexts).toEqual(["media", "general"]);
});

it("lists the camera tool among the host's declared device tools", async () => {
  const f = await fixture();
  await withDeviceActionTurn(
    f.runtime,
    f.credential,
    async () => {
      expect(deviceActionToolGuidance(f.runtime, CAMERA, f.message)).toContain(
        "DEVICE_CAMERA_CAPTURE",
      );
      expect(
        deviceActionToolGuidance(f.runtime, ["clock.handoff.v1"], f.message),
      ).not.toContain("DEVICE_CAMERA_CAPTURE");
    },
    ownerCaller(f.credential.subjectUserId),
  );
});

it("proposes the lens the owner named, not the model's choice", async () => {
  const f = await fixture("take a selfie");
  const propose = vi
    .spyOn(proposeDeviceAction, "handler")
    .mockResolvedValue({ success: true });
  await withDeviceActionTurn(
    f.runtime,
    f.credential,
    async () => {
      setDeviceActionRequestMessage(f.runtime, f.message);
      await camera.handler?.(f.runtime, f.message, undefined, {
        parameters: {
          operation: { type: "camera_capture_photo", lens: "back" },
          operationKey: "capture-1",
          reason: "The owner asked for a selfie.",
        },
      } as never);
    },
    ownerCaller(f.credential.subjectUserId),
  );
  expect(propose).toHaveBeenCalledTimes(1);
  const options = propose.mock.calls[0]?.[3] as
    | { parameters: { operation: unknown } }
    | undefined;
  expect(options?.parameters.operation).toEqual({
    type: "camera_capture_photo",
    lens: "front",
  });
});
