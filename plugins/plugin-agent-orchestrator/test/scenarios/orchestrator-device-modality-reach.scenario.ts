/**
 * Scenario-runner scenario asserting which device modalities can spawn a local
 * coding agent versus receiving the sandbox stub, read from the device-support matrix.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  installOrchestratorScenarioHarness,
  ORCHESTRATOR_DEVICE_MODALITY_REACH,
  ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
  registerVerifierFixtures,
} from "./_helpers/orchestrator-scenario-harness";

function actionData(ctx: ScenarioContext): Record<string, unknown> | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_DEVICE_MODALITY_REACH,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

export default scenario({
  id: "orchestrator-device-modality-reach",
  lane: "pr-deterministic",
  title:
    "Device and voice reach: desktop/Android spawn, iOS/store stubs, voice remote control",
  domain: "agent-orchestrator",
  tags: [
    "orchestrator",
    "device",
    "mobile",
    "ios",
    "android",
    "voice",
    "multi-account",
    "pr",
    "deterministic",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [ORCHESTRATOR_SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "install deterministic device/modality harness",
      apply: async (ctx) => {
        await installOrchestratorScenarioHarness(ctx);
        registerVerifierFixtures(
          ctx.runtime as Parameters<typeof registerVerifierFixtures>[0],
          ORCHESTRATOR_DEVICE_MODALITY_REACH,
          [
            {
              passed: true,
              summary:
                "The voice-origin task preserved metadata, used the selected Claude subscription, and produced a narrated completion.",
              missing: [],
            },
          ],
        );
        // No judge fixture: this scenario has no judgeRubric/responseJudge
        // check, so a registered judge stub would be dead weight.
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "prove device support matrix, mobile stubs, and voice delegation",
      text: "Exercise coding-agent device and voice reach.",
      actionName: ORCHESTRATOR_DEVICE_MODALITY_REACH,
      responseIncludesAny: [
        "desktop + Android local-yolo support",
        "iOS/store clean stubs",
        "voice-origin iOS remote-controller task",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | Record<string, unknown>
          | undefined;
        const deviceSupport =
          data?.deviceSupport && typeof data.deviceSupport === "object"
            ? (data.deviceSupport as Record<string, unknown>)
            : {};
        const matrix = asRecords(deviceSupport.matrix);
        const ids = new Map(matrix.map((row) => [String(row.id), row]));
        for (const id of ["desktop", "android-local-yolo"]) {
          if (ids.get(id)?.supported !== true) {
            return `expected ${id} to be supported`;
          }
        }
        if (ids.get("ios")?.reason !== "vanilla_mobile") {
          return `expected ios reason vanilla_mobile, saw ${String(ids.get("ios")?.reason)}`;
        }
        if (ids.get("store")?.reason !== "store_build") {
          return `expected store reason store_build, saw ${String(ids.get("store")?.reason)}`;
        }
        const stubs = asRecords(deviceSupport.stubs);
        const stubReasons = new Set(stubs.map((stub) => stub.actualReason));
        for (const reason of [
          "MOBILE_TERMINAL_UNSUPPORTED",
          "STORE_BUILD_BLOCKED",
          "AOSP_TERMINAL_REQUIRES_LOCAL_YOLO",
        ]) {
          if (!stubReasons.has(reason)) {
            return `expected stub reason ${reason}`;
          }
        }
        const voice =
          data?.voice && typeof data.voice === "object"
            ? (data.voice as Record<string, unknown>)
            : {};
        if (voice.source !== "voice" || voice.channelType !== "VOICE_DM") {
          return `expected voice metadata to survive, saw ${JSON.stringify(voice)}`;
        }
        if (voice.accountProviderId !== "anthropic-subscription") {
          return `expected voice task to select Claude subscription, saw ${String(voice.accountProviderId)}`;
        }
        if (voice.finalStatus !== "done") {
          return `expected voice task to be done, saw ${String(voice.finalStatus)}`;
        }
        if (!String(voice.narratedCompletion ?? "").includes("Narrated")) {
          return "expected narrated voice completion";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_DEVICE_MODALITY_REACH,
      status: "success",
    },
    {
      type: "custom",
      name: "device matrix and voice delegation are evidenced",
      predicate: (ctx) => {
        const data = actionData(ctx);
        const spawned = asRecords(data?.spawnedProfiles);
        const profileIds = new Set(spawned.map((row) => row.profileId));
        for (const id of ["desktop", "android-local-yolo"]) {
          if (!profileIds.has(id)) return `missing spawned profile ${id}`;
        }
        if (
          spawned.some(
            (row) =>
              typeof row.accountProviderId !== "string" ||
              typeof row.accountId !== "string",
          )
        ) {
          return "spawned profiles must carry selected account metadata";
        }
        const voice =
          data?.voice && typeof data.voice === "object"
            ? (data.voice as Record<string, unknown>)
            : {};
        if (voice.voiceSource !== "ios-capacitor") {
          return `expected ios-capacitor voice source, saw ${String(voice.voiceSource)}`;
        }
        return undefined;
      },
    },
  ],
});
