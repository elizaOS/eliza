import type {
  ScenarioFinalCheck,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export const CONNECTOR_CERTIFICATION_AXES = [
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

export type ConnectorCertificationAxis =
  (typeof CONNECTOR_CERTIFICATION_AXES)[number];

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

type ConnectorCertificationScenarioConfig = {
  id: string;
  title: string;
  connector: string;
  axis: ConnectorCertificationAxis;
  /** CI lane; defaults to `live-only` (certification exercises real connectors). */
  lane?: "pr-deterministic" | "live-only";
  tags?: string[];
  description: string;
  roomSource?: string;
  seed?: ScenarioSeedStep[];
  turns: ConnectorTurnConfig[];
  finalChecks?: ScenarioFinalCheck[];
};

export function buildConnectorCertificationScenario(
  config: ConnectorCertificationScenarioConfig,
) {
  const acceptedActions = Array.from(
    new Set(config.turns.flatMap((turn) => turn.expectedActions)),
  );
  const includesAny = config.turns.flatMap(
    (turn) => turn.actionPayloadIncludesAny ?? [],
  );

  function buildCertificationTurnText(turn: ConnectorTurnConfig): string {
    return [
      `Connector certification run for ${config.connector}.`,
      config.axis === "core"
        ? "Perform the requested workflow now using the real connector path that best matches the request."
        : // Deliberately does NOT name the seeded degradation: the agent must
          // discover the connector's real condition itself and report it.
          "Perform the requested workflow now, and if the connector is not healthy, surface its real condition instead of pretending it is.",
      turn.text,
    ]
      .filter((part) => part.length > 0)
      .join(" ");
  }

  return scenario({
    id: config.id,
    title: config.title,
    domain: "connector-certification",
    lane: config.lane ?? "live-only",
    tags: [
      "connector-certification",
      config.connector,
      `connector-certification-axis:${config.axis}`,
      ...(config.axis === "core" ? [] : ["connector-certification-degraded"]),
      ...(config.tags ?? []),
    ],
    description: config.description,
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
      text: buildCertificationTurnText(turn),
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
      // Side-effect assertion: connector certification must leave an observable
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
          description: `${config.connector} connector certification`,
          includesAny,
        }),
      },
      // LLM-judge rubric on the overall scenario outcome. The runner picks
      // this up via the `judgeRubric` typed final check.
      judgeRubric({
        name: `${config.id}-rubric`,
        threshold: 0,
        description: `End-to-end check: did the assistant actually exercise the ${config.connector} connector for the certification flow described as "${config.description}"? Score high only when the connector was used end-to-end (read, draft, send, hold, or whatever the certification calls for) and any failure was surfaced explicitly.`,
      }),
    ],
  });
}
