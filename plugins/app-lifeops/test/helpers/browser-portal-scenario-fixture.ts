/**
 * browser-portal scenario FIXTURE — not a planner test harness.
 *
 * This fixture hard-bans `useModel` (see the `useModel` thunk below) and
 * implements `handleTurn` as a lowercased regex cascade over the incoming
 * message text (see the `needsPortal*` / `needsIdCopyEscalation` checks
 * around L360-425). Each matched phrase returns a pre-built ActionResult.
 *
 * The test file that consumes this fixture
 * (`../browser-portal.scenario.test.ts`) is therefore a regression test of
 * THIS FIXTURE'S string-match routing, not of the real LifeOps planner.
 * If you change the input phrases in the scenarios, you also have to update
 * the regexes here — there is no LLM fallback.
 */
import type {
  Action,
  ActionResult,
  AgentRuntime,
  Content,
  HandlerOptions,
  Memory,
  State,
} from "@elizaos/core";
import type { CapturedStateTransition } from "@elizaos/scenario-schema";
import { summarizeBrowserTaskLifecycle } from "../../src/lifeops/browser-session-lifecycle.js";
import { LifeOpsRepository } from "../../src/lifeops/repository.js";
import { LifeOpsService } from "../../src/lifeops/service.js";
import {
  createLifeOpsChatTestRuntime,
  type LifeOpsChatTurnResult,
} from "./lifeops-chat-runtime.js";

type PortalFixtureState = {
  uploadSessionId: string | null;
};

const RUNTIME_CAPTURE_HOOK = Symbol.for("scenario-runner.capture-hooks");

function recordFixtureInterventionTransition(
  runtime: AgentRuntime,
  channel: string,
): void {
  const hooks = (runtime as Record<PropertyKey, unknown>)[RUNTIME_CAPTURE_HOOK];
  if (!hooks || typeof hooks !== "object") return;
  const stateTransitions = (hooks as { stateTransitions?: unknown })
    .stateTransitions;
  if (!Array.isArray(stateTransitions)) return;
  stateTransitions.push({
    subject: "intervention",
    from: "none",
    to: "requested",
    actionName: "DEVICE_INTENT",
    metadata: { channel, reason: "expired_id_copy" },
    at: new Date().toISOString(),
  } satisfies CapturedStateTransition);
}

function lowerText(message: Record<string, unknown>): string {
  const content =
    message.content && typeof message.content === "object"
      ? (message.content as Record<string, unknown>)
      : {};
  return String(content.text ?? "")
    .trim()
    .toLowerCase();
}

async function createService(runtime: AgentRuntime): Promise<LifeOpsService> {
  await LifeOpsRepository.bootstrapSchema(runtime);
  const service = new LifeOpsService(runtime);
  await service.updateBrowserSettings({
    enabled: true,
    allowBrowserControl: true,
  });
  await service.syncBrowserState({
    companion: {
      browser: "chrome",
      profileId: "profile-1",
      label: "LifeOps Browser Chrome",
      connectionState: "connected",
      permissions: {
        tabs: true,
        scripting: true,
        activeTab: true,
        allOrigins: true,
        grantedOrigins: ["https://speaker-portal.example.com"],
        incognitoEnabled: false,
      },
    },
    tabs: [
      {
        browser: "chrome",
        profileId: "profile-1",
        windowId: "window-1",
        tabId: "tab-1",
        url: "https://speaker-portal.example.com/submissions",
        title: "Speaker Portal",
        activeInWindow: true,
        focusedWindow: true,
        focusedActive: true,
      },
    ],
    pageContexts: [
      {
        browser: "chrome",
        profileId: "profile-1",
        windowId: "window-1",
        tabId: "tab-1",
        url: "https://speaker-portal.example.com/submissions",
        title: "Speaker Portal",
        mainText: "Speaker portal submissions",
      },
    ],
  });
  return service;
}

function needsPortalKickoff(text: string): boolean {
  return (
    text.includes("upload the file through the portal") ||
    text.includes("i sent the final deck") ||
    text.includes("upload it now")
  );
}

function needsPortalStandingInstruction(text: string): boolean {
  return text.includes("when i send over the deck");
}

function needsPortalResume(text: string): boolean {
  return text.includes("resume the upload") || text.includes("portal sign-in");
}

function needsIdCopyEscalation(text: string): boolean {
  return text.includes("only id on file is expired");
}

async function createBlockedPortalSession(
  service: LifeOpsService,
  fixtureState: PortalFixtureState,
) {
  if (fixtureState.uploadSessionId) {
    return service.getBrowserSession(fixtureState.uploadSessionId);
  }
  const companion = (await service.listBrowserCompanions())[0];
  const created = await service.createBrowserSession({
    title: "Upload deck to speaker portal",
    browser: "chrome",
    profileId: "profile-1",
    companionId: companion?.id ?? null,
    actions: [
      {
        kind: "open",
        label: "Open speaker portal",
        url: "https://speaker-portal.example.com/submissions",
        selector: null,
        text: null,
        accountAffecting: false,
        requiresConfirmation: false,
        metadata: { workflowKind: "portal_upload" },
      },
      {
        kind: "click",
        label: "Submit uploaded deck",
        url: null,
        selector: "#submit-upload",
        text: null,
        accountAffecting: true,
        requiresConfirmation: true,
        metadata: { workflowKind: "portal_upload" },
      },
    ],
  });
  fixtureState.uploadSessionId = created.id;
  await service.confirmBrowserSession(created.id, { confirmed: true });
  return service.updateBrowserSessionProgress(created.id, {
    currentActionIndex: 1,
    result: {
      browserTask: {
        approvalRequired: true,
        approvalSatisfied: true,
        needsHuman: true,
        blockedReason: "portal login required",
        artifacts: [
          {
            kind: "input_asset",
            label: "eliza-keynote.pdf",
            detail: "received from chat",
          },
        ],
        interventions: [
          {
            kind: "login",
            reason: "Portal sign-in required",
            status: "requested",
            channel: "dashboard",
          },
        ],
      },
    },
  });
}

async function resumePortalSession(
  service: LifeOpsService,
  fixtureState: PortalFixtureState,
) {
  if (!fixtureState.uploadSessionId) {
    throw new Error("portal session does not exist yet");
  }
  await service.updateBrowserSessionProgress(fixtureState.uploadSessionId, {
    result: {
      browserTask: {
        needsHuman: false,
        interventions: [
          {
            kind: "login",
            reason: "Portal sign-in required",
            status: "resolved",
            channel: "dashboard",
          },
        ],
        uploadedAssets: [
          {
            kind: "uploaded_deck",
            label: "eliza-keynote.pdf",
            detail: "uploaded to the speaker portal",
            uploaded: true,
          },
        ],
        provenance: [
          {
            provider: "speaker_portal",
            label: "Speaker Portal Submission",
            url: "https://speaker-portal.example.com/submissions/rec-123",
            externalId: "rec-123",
            detail: "submission receipt",
          },
        ],
      },
    },
  });
  return service.completeBrowserSession(fixtureState.uploadSessionId, {
    status: "done",
  });
}

export async function createBrowserPortalScenarioRuntime(agentId: string) {
  const fixtureState: PortalFixtureState = {
    uploadSessionId: null,
  };
  let service: LifeOpsService | null = null;
  const computerUseAction: Action = {
    name: "COMPUTER_USE",
    similes: [],
    description: "Deterministic browser portal fixture action.",
    validate: async () => true,
    handler: async (
      _runtime,
      _message,
      _state,
      options,
    ): Promise<ActionResult> => {
      if (!service) {
        throw new Error("browser portal scenario service is not ready");
      }
      const parameters =
        ((options as HandlerOptions | undefined)?.parameters as
          | Record<string, unknown>
          | undefined) ?? {};
      const phase =
        typeof parameters.phase === "string" ? parameters.phase : null;

      if (phase === "standing_instruction") {
        return {
          success: true,
          text: "Once you send the deck, I'll handle the portal upload on your machine and keep it gated behind your approval before the irreversible step.",
          data: {
            browserTask: {
              approvalRequired: true,
              approvalSatisfied: false,
              completed: false,
              needsHuman: false,
              artifactCount: 0,
              uploadedAssetCount: 0,
              interventionCount: 0,
              provenanceCount: 0,
            },
          },
        };
      }

      if (phase === "portal_blocked") {
        const blocked = await createBlockedPortalSession(service, fixtureState);
        return {
          success: true,
          text: "I reached the speaker portal, but the upload is blocked because the portal needs your sign-in before I can submit the deck.",
          data: {
            browserTask: summarizeBrowserTaskLifecycle(blocked),
            sessionId: blocked.id,
          },
        };
      }

      if (phase === "portal_resume") {
        const completed = await resumePortalSession(service, fixtureState);
        return {
          success: true,
          text: "The deck is uploaded. Receipt link: https://speaker-portal.example.com/submissions/rec-123",
          data: {
            browserTask: summarizeBrowserTaskLifecycle(completed),
            sessionId: completed.id,
          },
        };
      }

      throw new Error(`Unhandled computer-use fixture phase: ${String(phase)}`);
    },
    examples: [],
  };
  const publishDeviceIntentAction: Action = {
    name: "DEVICE_INTENT",
    similes: [],
    description: "Deterministic ID-copy intervention fixture action.",
    validate: async () => true,
    handler: async (
      runtime,
      _message,
      _state,
      options,
    ): Promise<ActionResult> => {
      const parameters =
        ((options as HandlerOptions | undefined)?.parameters as
          | Record<string, unknown>
          | undefined) ?? {};
      const channel =
        typeof parameters.channel === "string"
          ? parameters.channel
          : "dashboard";
      recordFixtureInterventionTransition(runtime, channel);
      return {
        success: true,
        text: "The workflow is blocked because the only ID on file is expired. Please send an updated copy and I'll continue as soon as it arrives.",
        data: {
          interventionRequest: {
            exists: true,
            channel,
            reason: "expired ID on file",
          },
          dispatch: {
            channel,
            message:
              "Please send an updated ID copy so the blocked workflow can continue.",
          },
        },
      };
    },
    examples: [],
  };

  async function respondWithActionResult(
    action: Action,
    message: Record<string, unknown>,
    state: State,
    onResponse: (content: Content) => Promise<object[]>,
    parameters: Record<string, unknown>,
  ): Promise<LifeOpsChatTurnResult> {
    const result = (await action.handler?.(runtime, message as Memory, state, {
      parameters,
    })) as ActionResult;
    const content: Content & Record<string, unknown> = {
      text: result?.text ?? "",
      actions: [action.name],
      ...(result?.data && typeof result.data === "object"
        ? { data: result.data, ...result.data }
        : {}),
    };
    await onResponse(content);
    return {
      text: result?.text ?? "",
      actions: [action.name],
      data:
        result?.data && typeof result.data === "object"
          ? (result.data as Record<string, unknown>)
          : undefined,
    };
  }

  const runtime = createLifeOpsChatTestRuntime({
    agentId,
    actions: [computerUseAction, publishDeviceIntentAction],
    useModel: async () => {
      throw new Error("scenario fixtures should not invoke useModel");
    },
    // NOTE: this is a canned string-match router, not a planner. See the
    // file-level JSDoc above. Each branch below is pinned to a specific
    // phrase in the companion scenario fixtures; if a new scenario prompt
    // is added it must also be routed here or the final `throw` trips.
    handleTurn: async ({
      message,
      onResponse,
      state,
    }): Promise<LifeOpsChatTurnResult> => {
      if (!service) {
        throw new Error("browser portal scenario service is not ready");
      }
      const text = lowerText(message);

      if (needsPortalStandingInstruction(text)) {
        return respondWithActionResult(
          computerUseAction,
          message,
          state,
          onResponse,
          {
            phase: "standing_instruction",
            workflowKind: "portal_upload",
            assetKind: "deck",
          },
        );
      }

      if (needsPortalKickoff(text)) {
        return respondWithActionResult(
          computerUseAction,
          message,
          state,
          onResponse,
          {
            phase: "portal_blocked",
            workflowKind: "portal_upload",
            assetKind: "deck",
            portal: "speaker_portal",
          },
        );
      }

      if (needsPortalResume(text)) {
        return respondWithActionResult(
          computerUseAction,
          message,
          state,
          onResponse,
          {
            phase: "portal_resume",
            workflowKind: "portal_upload",
            assetKind: "deck",
            portal: "speaker_portal",
          },
        );
      }

      if (needsIdCopyEscalation(text)) {
        return respondWithActionResult(
          publishDeviceIntentAction,
          message,
          state,
          onResponse,
          {
            workflowKind: "identity_upload",
            channel: "dashboard",
            reason: "expired_id_copy",
          },
        );
      }

      throw new Error(`Unhandled browser portal scenario text: ${text}`);
    },
  });
  (
    runtime as unknown as {
      plugins?: Array<{ name: string }>;
    }
  ).plugins = [{ name: "@elizaos/plugin-agent-skills" }];

  service = await createService(runtime);
  return runtime;
}
