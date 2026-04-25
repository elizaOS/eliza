/**
 * SHAPE-ONLY fixture guard for the blocker scenarios that were recently
 * converted from NotYetImplemented placeholders.
 *
 * This file does not execute the live scenario runner. It keeps the scenario
 * fixtures from silently regressing back into placeholders or rubber-stamp
 * predicates, while behavioral coverage lives in connector-blockers.test.ts.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@elizaos/scenario-schema",
  () => ({
    scenario: <T>(value: T) => value,
  }),
  { virtual: true },
);

type ScenarioFinalCheck = {
  type?: string;
  name?: string;
  predicate?: (ctx: {
    actionsCalled: unknown[];
    turns?: unknown[];
    approvalRequests?: unknown[];
    connectorDispatches?: unknown[];
    memoryWrites?: unknown[];
    stateTransitions?: unknown[];
  }) => Promise<unknown> | unknown;
  [key: string]: unknown;
};

type TsScenario = {
  id: string;
  finalChecks?: ScenarioFinalCheck[];
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

const BLOCKER_SCENARIOS = [
  {
    id: "cross-platform.escalation-to-user",
    relativePath:
      "test/scenarios/messaging.cross-platform/cross-platform.escalation-to-user.scenario.ts",
    requiredSnippets: ["receivePendingIntents", "intentId", "lease"],
  },
  {
    id: "cross-platform.group-chat-gateway",
    relativePath:
      "test/scenarios/messaging.cross-platform/cross-platform.group-chat-gateway.scenario.ts",
    requiredSnippets: ["getRoom", "getParticipantsForRoom", "participantEntityIds"],
  },
  {
    id: "telegram.local.mute-chat",
    relativePath:
      "test/scenarios/messaging.telegram-local/telegram.local.mute-chat.scenario.ts",
    requiredSnippets: ["getParticipantUserState", "listTriggerTasks", "unmute_chat"],
  },
  {
    id: "twitter.dm.schedule-reply",
    relativePath:
      "test/scenarios/messaging.twitter-dm/twitter.dm.schedule-reply.scenario.ts",
    requiredSnippets: ["listTriggerTasks", "REPLY_X_DM", "sendAtIso"],
  },
  {
    id: "twilio.call.receive",
    relativePath: "test/scenarios/gateway/twilio.call.receive.scenario.ts",
    requiredSnippets: ["responseText", "actionsCalled", "voice transcript"],
  },
] as const;

async function loadScenario(relativePath: string): Promise<TsScenario> {
  const module = await import(
    pathToFileURL(path.join(REPO_ROOT, relativePath)).href
  );
  return module.default as TsScenario;
}

describe("Connector blocker scenario fixtures", () => {
  it("stay loadable, non-placeholder, and fail closed on bogus context", async () => {
    const bogusCtx = {
      actionsCalled: [{ actionName: "WRONG_ACTION", parameters: {} }],
      turns: [{ responseText: "", actionsCalled: [] }],
      approvalRequests: [],
      connectorDispatches: [],
      memoryWrites: [],
      stateTransitions: [],
    };

    for (const entry of BLOCKER_SCENARIOS) {
      const [scenario, source] = await Promise.all([
        loadScenario(entry.relativePath),
        readFile(path.join(REPO_ROOT, entry.relativePath), "utf8"),
      ]);

      expect(scenario.id).toBe(entry.id);
      expect(source).not.toContain("NotYetImplemented");
      expect(scenario.finalChecks?.some((check) => check.type === "selectedAction")).toBe(
        true,
      );

      const customChecks = (scenario.finalChecks ?? []).filter(
        (check) => check.type === "custom" && typeof check.predicate === "function",
      );
      expect(customChecks.length).toBeGreaterThan(0);

      for (const check of customChecks) {
        const result = await check.predicate?.(bogusCtx);
        expect(
          typeof result === "string" && result.trim().length > 0,
          `${entry.id}:${check.name ?? "custom"} should reject bogus context`,
        ).toBe(true);
      }

      for (const snippet of entry.requiredSnippets) {
        expect(source).toContain(snippet);
      }
    }
  });
});
