import type { Scenario } from "../types.js";
import { integrationScenarios } from "./integration.js";
import { pluginConfigScenarios } from "./plugin-config.js";
import { pluginFlowScenarios } from "./plugin-flows.js";
import { pluginLifecycleScenarios } from "./plugin-lifecycle.js";
import { secretsCrudScenarios } from "./secrets-crud.js";
import { secretsSecurityScenarios } from "./secrets-security.js";

type ScenarioVariant = {
  id: string;
  label: string;
  description: string;
  rewrite: (text: string, scenario: Scenario) => string;
};

const EXPANSION_MULTIPLIER = 10;

const EDGE_VARIANTS: ScenarioVariant[] = [
  {
    id: "polite",
    label: "polite ask",
    description: "Adds polite conversational framing before the request.",
    rewrite: (text) => `Please help with this when you can: ${text}`,
  },
  {
    id: "urgent",
    label: "urgent operations note",
    description: "Frames the request as urgent without changing its intent.",
    rewrite: (text) => `This is blocking my setup right now. ${text}`,
  },
  {
    id: "followup",
    label: "follow-up turn",
    description: "Presents the message as a follow-up in an existing thread.",
    rewrite: (text) => `Following up from earlier: ${text}`,
  },
  {
    id: "mobile",
    label: "mobile context",
    description: "Adds a mobile-typed preface while preserving exact values.",
    rewrite: (text) => `Sent from mobile, sorry for the short note: ${text}`,
  },
  {
    id: "quoted",
    label: "quoted request",
    description: "Includes the request in quoted-message form.",
    rewrite: (text) => `Forwarded request:\n> ${text}`,
  },
  {
    id: "newline",
    label: "line-broken request",
    description: "Adds line breaks around the core request.",
    rewrite: (text) => `Context: account configuration\n\n${text}`,
  },
  {
    id: "handoff",
    label: "teammate handoff",
    description: "Frames the request as delegated by a teammate.",
    rewrite: (text) => `My teammate asked me to handle this here: ${text}`,
  },
  {
    id: "audit",
    label: "audit-sensitive",
    description: "Adds audit and logging concerns around the request.",
    rewrite: (text) =>
      `For the audit trail, please be careful and log this: ${text}`,
  },
  {
    id: "confirm",
    label: "confirmation requested",
    description: "Asks for confirmation after the requested operation.",
    rewrite: (text) => `Please confirm once this is handled: ${text}`,
  },
  {
    id: "boundary",
    label: "instruction boundary",
    description: "Wraps the request in explicit user-intent boundaries.",
    rewrite: (text, scenario) =>
      `User intent begins below (${scenario.channel} channel):\n${text}`,
  },
];

if (EDGE_VARIANTS.length !== EXPANSION_MULTIPLIER) {
  throw new Error(
    `ConfigBench expansion requires exactly ${EXPANSION_MULTIPLIER} variants, found ${EDGE_VARIANTS.length}`,
  );
}

export const BASE_SCENARIOS: Scenario[] = [
  ...secretsCrudScenarios,
  ...secretsSecurityScenarios,
  ...pluginLifecycleScenarios,
  ...pluginConfigScenarios,
  ...pluginFlowScenarios,
  ...integrationScenarios,
];

function applyVariant(scenario: Scenario, variant: ScenarioVariant): Scenario {
  return {
    ...scenario,
    id: `${scenario.id}--edge-${variant.id}`,
    name: `${scenario.name} (${variant.label})`,
    description: `${scenario.description} Edge variant: ${variant.description}`,
    messages: scenario.messages.map((message) =>
      message.from === "user"
        ? { ...message, text: variant.rewrite(message.text, scenario) }
        : { ...message },
    ),
  };
}

export const EXPANDED_SCENARIOS: Scenario[] = BASE_SCENARIOS.flatMap(
  (scenario) => EDGE_VARIANTS.map((variant) => applyVariant(scenario, variant)),
);

if (
  EXPANDED_SCENARIOS.length !==
  BASE_SCENARIOS.length * EXPANSION_MULTIPLIER
) {
  throw new Error(
    `ConfigBench scenario expansion mismatch: expected ${BASE_SCENARIOS.length * EXPANSION_MULTIPLIER}, found ${EXPANDED_SCENARIOS.length}`,
  );
}

export const ALL_SCENARIOS: Scenario[] = [
  ...BASE_SCENARIOS,
  ...EXPANDED_SCENARIOS,
];

export function countConfigBenchScenarios(): {
  suite: "configbench";
  existing: number;
  added: number;
  total: number;
  multiplierAdded: number;
} {
  return {
    suite: "configbench",
    existing: BASE_SCENARIOS.length,
    added: EXPANDED_SCENARIOS.length,
    total: ALL_SCENARIOS.length,
    multiplierAdded: EXPANDED_SCENARIOS.length / BASE_SCENARIOS.length,
  };
}

export function validateConfigBenchScenarios(): {
  valid: boolean;
  total: number;
  uniqueIds: number;
  duplicateIds: string[];
  emptyMessages: string[];
  expansionMatches: boolean;
} {
  const ids = new Set<string>();
  const duplicateIds = new Set<string>();
  const emptyMessages: string[] = [];

  for (const scenario of ALL_SCENARIOS) {
    if (ids.has(scenario.id)) duplicateIds.add(scenario.id);
    ids.add(scenario.id);

    if (
      scenario.messages.length === 0 ||
      scenario.messages.some((message) => message.text.trim().length === 0)
    ) {
      emptyMessages.push(scenario.id);
    }
  }

  const expansionMatches =
    EXPANDED_SCENARIOS.length === BASE_SCENARIOS.length * EXPANSION_MULTIPLIER;

  return {
    valid:
      duplicateIds.size === 0 && emptyMessages.length === 0 && expansionMatches,
    total: ALL_SCENARIOS.length,
    uniqueIds: ids.size,
    duplicateIds: [...duplicateIds],
    emptyMessages,
    expansionMatches,
  };
}
