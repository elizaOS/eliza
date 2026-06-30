/**
 * orchestrator-watchdog-stall (#8901) — deterministic, keyless evidence that the
 * TaskWatchdogService (a) grills an idle/quiet sub-agent once, and (b) warns the
 * originating room when a session approaches its round-trip or spend cap, and
 * that ACTIVE_SUB_AGENTS surfaces both signals.
 *
 * It drives the REAL `TaskWatchdogService.runOnce` and the REAL
 * `activeSubAgentsProvider.get` against an in-memory ACP boundary + a structural
 * round-trip source + a spend ledger seeded over 80% — no model, no subprocess —
 * mirroring how the multi-task supervisor scenario exercises the real pure
 * supervisor functions. The fake ACP/router are only the subprocess/loop-guard
 * boundary the production watchdog reads; the detection, dedup, room-post, and
 * provider rendering are all the shipped code.
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { activeSubAgentsProvider } from "../../src/providers/active-sub-agents.js";
import {
  addSessionSpendUsd,
  resetSessionSpendUsd,
} from "../../src/services/spend-allowance.js";
import {
  STALL_GRILL_PROMPT,
  TASK_WATCHDOG_SERVICE_TYPE,
  TaskWatchdogService,
} from "../../src/services/task-watchdog-service.js";

const WATCHDOG_SCENARIO_PLUGIN_NAME = "orchestrator-watchdog-scenario";
const ORCHESTRATOR_WATCHDOG_STALL = "ORCHESTRATOR_WATCHDOG_STALL";

const NOW = 1_000_000_000;
const ROOM_IDLE = "11111111-1111-4111-8111-111111111111";
const ROOM_LOOP = "22222222-2222-4222-8222-222222222222";
const IDLE_SESSION = "watchdog-idle-1";
const LOOP_SESSION = "watchdog-loop-1";

type WatchdogScenarioResult = {
  summary: string;
  grilledSessionId: string;
  stallPromptSent: boolean;
  warnings: Array<{ roomId?: string; source?: string; kind: string }>;
  approachingCap: Array<{ id: string; kind: string }>;
  providerText: string;
  providerStalled: string[];
  providerApproachingCap: Record<string, string | null>;
};

function watchdogScenarioData(
  ctx: ScenarioContext,
): WatchdogScenarioResult | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_WATCHDOG_STALL,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as WatchdogScenarioResult)
    : null;
}

async function runWatchdogStall(): Promise<WatchdogScenarioResult> {
  const priorConfigPath = process.env.ELIZA_CONFIG_PATH;
  const priorCap = process.env.ELIZA_AGENT_SPEND_CAP_USD;
  process.env.ELIZA_CONFIG_PATH = "/nonexistent-watchdog-scenario-config.json";
  process.env.ELIZA_AGENT_SPEND_CAP_USD = "1.00";
  resetSessionSpendUsd();
  addSessionSpendUsd(LOOP_SESSION, 0.85); // 85% of the $1.00 cap

  const grills: Array<{ sessionId: string; text: string }> = [];
  const posts: Array<{ roomId?: string; source?: string; text: string }> = [];

  const sessions = [
    {
      // Idle past the stall threshold → gets one status-check grill.
      id: IDLE_SESSION,
      status: "running",
      lastActivityAt: new Date(NOW - 200_000),
      metadata: { roomId: ROOM_IDLE, source: "telegram", label: "Ada" },
    },
    {
      // Active (recent) but over 80% of the round-trip + spend caps → warned.
      id: LOOP_SESSION,
      status: "running",
      lastActivityAt: new Date(NOW - 1_000),
      metadata: { roomId: ROOM_LOOP, source: "discord", label: "Lin" },
    },
  ];

  const acp = {
    listSessions: async () => sessions,
    sendToSession: async (sessionId: string, text: string) => {
      grills.push({ sessionId, text });
      return {};
    },
    getSessionOutput: undefined,
  };
  const router = {
    getRoundTripCap: () => 32,
    getRoundTripCount: (id: string) => (id === LOOP_SESSION ? 26 : 0), // 81%
  };

  let watchdog: TaskWatchdogService | undefined;
  const runtime = {
    agentId: "watchdog-scenario-agent",
    getSetting: () => undefined,
    getService: (type: string) => {
      if (type === "ACP_SUBPROCESS_SERVICE") return acp;
      if (type === "ACPX_SUB_AGENT_ROUTER") return router;
      if (type === TASK_WATCHDOG_SERVICE_TYPE) return watchdog ?? null;
      return null;
    },
    sendMessageToTarget: async (
      target: { source: string; roomId?: string },
      content: { text?: string; source?: string },
    ) => {
      posts.push({
        roomId: target.roomId,
        source: target.source,
        text: content.text ?? "",
      });
      return undefined;
    },
  } as unknown as IAgentRuntime;

  watchdog = new TaskWatchdogService(runtime);
  await watchdog.runOnce(NOW);

  // --- Assertions (throw → scenario fails loudly on regression). ---
  const stallPromptSent = grills.some(
    (g) => g.sessionId === IDLE_SESSION && g.text === STALL_GRILL_PROMPT,
  );
  if (!stallPromptSent) {
    throw new Error("idle session was not grilled with the stall prompt");
  }
  if (grills.some((g) => g.sessionId === LOOP_SESSION)) {
    throw new Error("active over-cap session must not be grilled as idle");
  }

  const roundTripWarn = posts.find(
    (p) => p.roomId === ROOM_LOOP && p.text.includes("round-trips"),
  );
  const spendWarn = posts.find(
    (p) => p.roomId === ROOM_LOOP && p.text.includes("budget"),
  );
  if (!roundTripWarn) throw new Error("missing round-trip cap warning");
  if (!spendWarn) throw new Error("missing spend cap warning");
  if (posts.some((p) => p.roomId === ROOM_IDLE)) {
    throw new Error(
      "idle session (0 round-trips / 0 spend) must not be warned",
    );
  }

  const approachingCap = watchdog.getApproachingCapSessionIds();
  if (
    !approachingCap.some(
      (w) => w.id === LOOP_SESSION && w.kind === "round-trip",
    ) ||
    !approachingCap.some((w) => w.id === LOOP_SESSION && w.kind === "spend")
  ) {
    throw new Error("watchdog did not record both approaching-cap kinds");
  }

  const provider = await activeSubAgentsProvider.get(
    runtime,
    {} as Memory,
    {} as State,
  );
  const providerText = provider.text ?? "";
  if (!providerText.includes("status=stalled")) {
    throw new Error("provider did not surface the stalled idle session");
  }
  if (!providerText.includes("approachingCap=round-trip")) {
    throw new Error("provider did not surface the approaching-cap session");
  }

  const providerSessions =
    (
      provider.data as {
        sessions?: Array<{
          sessionId: string;
          stalled: boolean;
          approachingCap: string | null;
        }>;
      }
    ).sessions ?? [];
  const providerStalled = providerSessions
    .filter((s) => s.stalled)
    .map((s) => s.sessionId);
  const providerApproachingCap: Record<string, string | null> =
    Object.fromEntries(
      providerSessions.map((s) => [s.sessionId, s.approachingCap]),
    );

  resetSessionSpendUsd();
  if (priorConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = priorConfigPath;
  if (priorCap === undefined) delete process.env.ELIZA_AGENT_SPEND_CAP_USD;
  else process.env.ELIZA_AGENT_SPEND_CAP_USD = priorCap;

  return {
    summary: `watchdog grilled the idle session ${IDLE_SESSION} once and posted a round-trip cap warning and a spend cap warning to the over-cap session's room; ACTIVE_SUB_AGENTS surfaced stalled + approachingCap`,
    grilledSessionId: IDLE_SESSION,
    stallPromptSent,
    warnings: [
      {
        roomId: roundTripWarn.roomId,
        source: roundTripWarn.source,
        kind: "round-trip",
      },
      { roomId: spendWarn.roomId, source: spendWarn.source, kind: "spend" },
    ],
    approachingCap,
    providerText,
    providerStalled,
    providerApproachingCap,
  };
}

function watchdogScenarioPlugin(): Plugin {
  const action: Action = {
    name: ORCHESTRATOR_WATCHDOG_STALL,
    description:
      "Drive the stalled-agent watchdog: grill an idle session, warn on round-trip + spend caps, and surface both via ACTIVE_SUB_AGENTS.",
    validate: async () => true,
    handler: async () => {
      const result = await runWatchdogStall();
      return {
        success: true,
        text: result.summary,
        userFacingText: result.summary,
        verifiedUserFacing: true,
        data: result,
      };
    },
  };
  return {
    name: WATCHDOG_SCENARIO_PLUGIN_NAME,
    description: "Deterministic watchdog cap-warning scenario action (#8901).",
    actions: [action],
  };
}

export default scenario({
  id: "orchestrator-watchdog-stall",
  lane: "pr-deterministic",
  title:
    "Orchestrator watchdog grills idle sub-agents and warns on round-trip + spend caps",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "watchdog", "stall", "caps", "pr", "deterministic"],
  isolation: "shared-runtime",
  requires: {
    plugins: [WATCHDOG_SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "register deterministic watchdog scenario action",
      apply: async (ctx) => {
        const runtime = ctx.runtime as {
          registerPlugin?: (plugin: Plugin) => Promise<void>;
          plugins?: Array<{ name?: string }>;
        };
        const already = runtime.plugins?.some(
          (plugin) => plugin.name === WATCHDOG_SCENARIO_PLUGIN_NAME,
        );
        if (!already) await runtime.registerPlugin?.(watchdogScenarioPlugin());
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "grill the idle session and warn on approaching caps",
      text: "Run the stalled-agent watchdog over a quiet session and an over-cap session.",
      actionName: ORCHESTRATOR_WATCHDOG_STALL,
      responseIncludesAny: [
        "watchdog grilled",
        "cap warning",
        "approachingCap",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | WatchdogScenarioResult
          | undefined;
        if (!data?.stallPromptSent) {
          return "expected the idle session to be grilled with the stall prompt";
        }
        const kinds = (data.warnings ?? []).map((w) => w.kind).sort();
        if (kinds.join(",") !== "round-trip,spend") {
          return `expected round-trip + spend cap warnings, saw ${JSON.stringify(kinds)}`;
        }
        if (!data.providerText.includes("approachingCap=round-trip")) {
          return "expected ACTIVE_SUB_AGENTS to surface approachingCap";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_WATCHDOG_STALL,
      status: "success",
    },
    {
      type: "custom",
      name: "watchdog grilled the idle session and warned on both caps",
      predicate: (ctx) => {
        const data = watchdogScenarioData(ctx);
        if (!data) return "watchdog scenario produced no data";
        if (data.grilledSessionId !== IDLE_SESSION || !data.stallPromptSent) {
          return "expected exactly the idle session to be grilled once";
        }
        const warned = (data.warnings ?? [])
          .filter((w) => w.roomId === ROOM_LOOP)
          .map((w) => w.kind)
          .sort();
        if (warned.join(",") !== "round-trip,spend") {
          return `expected round-trip + spend warnings to the over-cap room, saw ${JSON.stringify(warned)}`;
        }
        const capKinds = (data.approachingCap ?? [])
          .filter((w) => w.id === LOOP_SESSION)
          .map((w) => w.kind)
          .sort();
        if (capKinds.join(",") !== "round-trip,spend") {
          return `expected getApproachingCapSessionIds to report both kinds, saw ${JSON.stringify(capKinds)}`;
        }
        if (!data.providerStalled.includes(IDLE_SESSION)) {
          return "expected the provider to surface the idle session as stalled";
        }
        if (data.providerApproachingCap[LOOP_SESSION] !== "round-trip") {
          return "expected the provider to surface the over-cap session as approachingCap=round-trip";
        }
        return undefined;
      },
    },
  ],
});
