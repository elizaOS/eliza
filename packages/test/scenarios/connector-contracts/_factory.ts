/** Builds simulated connector-contract scenarios against scenario-runner's real runtime. */

import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "@elizaos/scenario-runner/scenario-assertions";
import type {
  ScenarioFinalCheck,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

export const CONNECTOR_CONTRACT_AXES = [
  "core",
  "missing-scope",
  "rate-limited",
  "disconnected",
  "auth-expired",
  "session-revoked",
  "delivery-degraded",
  "helper-disconnected",
  "retry-idempotent",
  "hold-expired",
  "transport-offline",
  "blocked-resume",
] as const;

export type ConnectorContractAxis = (typeof CONNECTOR_CONTRACT_AXES)[number];

type ConnectorTurnConfig = {
  name: string;
  text: string;
  /** Executor-enforced reply matcher (emitted as turn `responseIncludesAny`). */
  responseIncludesAny: Array<string | RegExp>;
  /**
   * Executor-enforced (emitted as turn `expectedActions`): at least one real
   * (non-synthesized) action called this turn must match the list. Also fed to
   * `expectTurnToCallAction` so payload matching applies to the same actions.
   */
  expectedActions: string[];
  /**
   * Payload matcher over the called action blob (name + args + result),
   * enforced via `expectTurnToCallAction` and the scenario-wide
   * action-coverage predicate.
   */
  actionPayloadIncludesAny?: Array<string | RegExp>;
  /**
   * Optional per-turn LLM judge rubric, enforced by the executor's
   * `responseJudge` path. The factory always adds a scenario-level
   * `judgeRubric` final check as well.
   */
  responseJudge?: { rubric: string; minimumScore?: number };
};

type ConnectorContractScenarioConfig = {
  evidenceScope: "connector-contract";
  id: string;
  title: string;
  connector: string;
  axis: ConnectorContractAxis;
  /** CI lane; defaults to `live-only` because the semantic judge needs a live model. */
  lane?: "pr-deterministic" | "live-only";
  status?: "active" | "pending";
  pendingReason?: string;
  tags?: string[];
  description: string;
  roomSource?: string;
  seed?: ScenarioSeedStep[];
  turns: ConnectorTurnConfig[];
  finalChecks?: ScenarioFinalCheck[];
};

export function buildConnectorContractScenario(
  config: ConnectorContractScenarioConfig,
) {
  const acceptedActions = Array.from(
    new Set(config.turns.flatMap((turn) => turn.expectedActions)),
  );
  const includesAny = config.turns.flatMap(
    (turn) => turn.actionPayloadIncludesAny ?? [],
  );

  function buildContractTurnText(turn: ConnectorTurnConfig): string {
    return [
      `Simulated connector contract run for ${config.connector}; this run is not provider-qualified.`,
      config.axis === "core"
        ? "Perform the requested workflow now using the registered connector action that best matches the request."
        : // Deliberately does NOT name the seeded degradation: the agent must
          // discover the simulated connector condition itself and report it.
          "Perform the requested workflow now, and if the simulated connector is not healthy, surface its observed condition instead of pretending it is.",
      turn.text,
    ]
      .filter((part) => part.length > 0)
      .join(" ");
  }

  const status =
    config.status ??
    (config.axis === "core" || config.axis === "retry-idempotent"
      ? "pending"
      : "active");

  return scenario({
    id: config.id,
    title: `Simulated connector contract: ${config.title}`,
    domain: "connector-contract",
    lane: config.lane ?? "live-only",
    status,
    ...(status === "pending"
      ? {
          pendingReason:
            config.pendingReason ??
            "Requires a stateful connector fixture with exact targets, authoritative receipts, durable readback, and replay coverage.",
        }
      : {}),
    executionProfile: "simulated",
    evidenceScope: config.evidenceScope,
    tags: [
      "connector-contract",
      "simulated-connector-contract",
      config.connector,
      `connector-contract-axis:${config.axis}`,
      ...(config.axis === "core" ? [] : ["connector-contract-degraded"]),
      ...(config.tags ?? []),
    ],
    description: `Simulated connector contract with fixture-backed evidence only. ${config.description}`,
    isolation: "per-scenario",
    requires: {
      plugins: ["@elizaos/plugin-agent-skills"],
    },
    seed: config.seed,
    rooms: [
      {
        id: "main",
        source: config.roomSource ?? "dashboard",
        channelType: "DM",
        title: config.title,
      },
    ],
    turns: config.turns.map((turn) => ({
      kind: "message",
      name: turn.name,
      room: "main",
      text: buildContractTurnText(turn),
      expectedActions: turn.expectedActions,
      assertTurn: expectTurnToCallAction({
        acceptedActions: turn.expectedActions,
        description: `${config.connector} connector step "${turn.name}"`,
        includesAny: turn.actionPayloadIncludesAny,
      }),
      responseIncludesAny: turn.responseIncludesAny,
      responseJudge: turn.responseJudge,
    })),
    finalChecks: [
      // Action-shape assertion: the right action was selected.
      {
        type: "selectedAction",
        actionName: acceptedActions,
      },
      // Side-effect assertion: the connector contract must leave an observable
      // trace in scenario memory even when the connector action is primarily a
      // read or planning workflow.
      {
        type: "memoryWriteOccurred",
        table: ["messages", "facts"],
      },
      ...(config.finalChecks ?? []),
      // Action-shape side-effect coverage predicate.
      {
        type: "custom",
        name: `${config.id}-action-coverage`,
        predicate: expectScenarioToCallAction({
          acceptedActions,
          description: `${config.connector} simulated connector contract`,
          includesAny,
        }),
      },
      // LLM-judge rubric on the overall scenario outcome. The runner picks
      // this up via the `judgeRubric` typed final check.
      judgeRubric({
        name: `${config.id}-rubric`,
        threshold: 0.7,
        description: `Simulated contract check: did the assistant select and exercise the registered ${config.connector} connector action for the workflow described as "${config.description}"? Score high only when the action result supports the claimed read, draft, send, or hold outcome and any simulated failure was surfaced explicitly. This check does not prove real-provider ingress, dispatch, or readback.`,
      }),
    ],
  });
}
