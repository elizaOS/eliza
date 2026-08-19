/** Guards turn-scoped no-dispatch assertions for simulated connector safety scenarios. */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ScenarioDefinition,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

async function loadScenario(relativePath: string): Promise<ScenarioDefinition> {
  const loaded = (await import(
    pathToFileURL(resolve(repoRoot, relativePath)).href
  )) as { default: ScenarioDefinition };
  return loaded.default;
}

function isZeroDispatchCheck(
  check: ScenarioFinalCheck,
): check is Extract<ScenarioFinalCheck, { type: "connectorDispatchOccurred" }> {
  return (
    check.type === "connectorDispatchOccurred" &&
    check.expected === false &&
    check.maxCount === 0 &&
    check.turn !== undefined
  );
}

function turnMatcherIncludes(
  matcher: string | string[] | undefined,
  expected: string,
): boolean {
  return typeof matcher === "string"
    ? matcher === expected
    : Array.isArray(matcher) && matcher.includes(expected);
}

const CONFIRMATION_GATES = [
  {
    file: "packages/test/scenarios/messaging.discord-local/discord.local.reply-to-dm.scenario.ts",
    turn: "request-discord-send",
  },
  {
    file: "packages/test/scenarios/messaging.gmail/gmail.send-with-confirmation.scenario.ts",
    turn: "draft reply saying thanks",
  },
  {
    file: "packages/test/scenarios/messaging.gmail/gmail.send.stale-confirmation-refused.scenario.ts",
    turn: "stale send confirmation",
  },
  {
    file: "packages/test/scenarios/messaging.gmail/gmail.refuse-send-without-confirmation.scenario.ts",
    turn: "mass email request",
  },
  {
    file: "packages/test/scenarios/messaging.imessage/imessage.reply-with-confirmation.scenario.ts",
    turn: "request-imessage-send",
  },
  {
    file: "packages/test/scenarios/messaging.signal/signal.reply.scenario.ts",
    turn: "request-signal-send",
  },
  {
    file: "packages/test/scenarios/messaging.whatsapp/whatsapp.reply.scenario.ts",
    turn: "request-whatsapp-send",
  },
] as const;

describe("simulated connector safety contracts", () => {
  it("pins every degraded connector contract to zero forbidden binding effects", async () => {
    const root = resolve(
      repoRoot,
      "packages/test/scenarios/connector-contracts",
    );
    const files = readdirSync(root)
      .filter((entry) => entry.endsWith(".scenario.ts"))
      .sort();
    const negativeAxes = new Set([
      "auth-expired",
      "blocked-resume",
      "delivery-degraded",
      "disconnected",
      "helper-disconnected",
      "hold-expired",
      "missing-scope",
      "rate-limited",
      "session-revoked",
      "transport-offline",
    ]);
    const degraded: ScenarioDefinition[] = [];

    for (const file of files) {
      const scenario = await loadScenario(
        `packages/test/scenarios/connector-contracts/${file}`,
      );
      const axis = scenario.tags
        ?.find((tag) => tag.startsWith("connector-contract-axis:"))
        ?.slice("connector-contract-axis:".length);
      if (axis && negativeAxes.has(axis)) degraded.push(scenario);
    }

    expect(degraded).toHaveLength(14);
    for (const scenario of degraded) {
      const turnName = scenario.turns[0]?.name;
      expect(turnName, scenario.id).toBeTruthy();
      const check = scenario.finalChecks?.find(isZeroDispatchCheck);
      expect(check, scenario.id).toBeDefined();
      expect(
        turnMatcherIncludes(check?.turn, turnName ?? ""),
        scenario.id,
      ).toBe(true);
      expect(
        typeof check?.channel === "string" ||
          (Array.isArray(check?.channel) && check.channel.length > 0),
        scenario.id,
      ).toBe(true);
    }
  });

  it("pins every outbound confirmation proposal to zero binding dispatches", async () => {
    expect(CONFIRMATION_GATES).toHaveLength(7);
    for (const gate of CONFIRMATION_GATES) {
      const scenario = await loadScenario(gate.file);
      expect(scenario.executionProfile ?? "simulated", scenario.id).toBe(
        "simulated",
      );
      const checks = (scenario.finalChecks ?? []).filter(isZeroDispatchCheck);
      expect(
        checks.some((check) => turnMatcherIncludes(check.turn, gate.turn)),
        scenario.id,
      ).toBe(true);
    }
  });
});
