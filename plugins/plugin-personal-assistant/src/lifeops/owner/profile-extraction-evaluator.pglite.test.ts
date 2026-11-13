/**
 * Real-PGlite proof that the timezone the plugin's `owner.profile_extraction`
 * evaluator stores from an owner message stays usable as the shared calendar
 * zone (plugin init registers the owner fact as the calendar zone resolver):
 * the period that ends the sentence is not part of the zone, an alias is
 * stored as its IANA zone, and a statement naming no zone leaves the stored
 * zone in place. The model-case block replays the scenarios that
 * quint/OwnerProfileTimezone.qnt generates (check-owner-profile-timezone.mjs).
 */

import { readFileSync } from "node:fs";
import { resolveCalendarTimeZone } from "@elizaos/contracts";
import {
  type AgentRuntime,
  type Memory,
  type MessageHandlerResult,
  runResponseHandlerEvaluators,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { resolveConfiguredOwnerTimeZone } from "./fact-store.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;

async function ownerSays(
  text: string,
  target: AgentRuntime = runtime,
): Promise<void> {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: target.agentId,
    entityId: target.agentId,
    roomId: crypto.randomUUID() as UUID,
    content: { source: "autonomy", text },
  } as Memory;
  const messageHandler: MessageHandlerResult = {
    processMessage: "RESPOND",
    plan: { contexts: [] },
    thought: "",
  };
  const result = await runResponseHandlerEvaluators({
    runtime: target,
    message,
    state: { text: "", values: {}, data: {} },
    messageHandler,
    availableContexts: [],
  });
  expect(
    result.errors.filter(
      (error) => error.evaluatorName === "owner.profile_extraction",
    ),
  ).toEqual([]);
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
}, 180_000);

afterAll(async () => {
  await runtimeResult?.cleanup();
});

describe("owner.profile_extraction timezone and the calendar zone", () => {
  it("resolves the calendar zone after the owner states it in a sentence", async () => {
    await ownerSays("My timezone is America/New_York.");

    await expect(resolveCalendarTimeZone(runtime, new Date())).resolves.toEqual(
      { timeZone: "America/New_York", source: "owner" },
    );
  });

  it("stores the IANA zone for an alias the shared resolver knows", async () => {
    await ownerSays("my timezone is pacific.");

    await expect(resolveCalendarTimeZone(runtime, new Date())).resolves.toEqual(
      { timeZone: "America/Los_Angeles", source: "owner" },
    );
  });

  it("keeps the stored zone when the owner names no zone", async () => {
    await ownerSays("My timezone is Europe/Berlin");
    await ownerSays("my timezone is whatever the laptop says.");

    await expect(resolveCalendarTimeZone(runtime, new Date())).resolves.toEqual(
      { timeZone: "Europe/Berlin", source: "owner" },
    );
  });
});

// Model encoding (quint/OwnerProfileTimezone.qnt): zone -1 none stored,
// 0..2 MODEL_ZONES; statement 0..3 MODEL_STATEMENTS; readZone 8 is the
// non-owner fallback.
const MODEL_ZONES = [
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
];
const MODEL_STATEMENTS = [
  "My timezone is America/New_York",
  "My timezone is America/New_York.",
  "my timezone is pacific.",
  "my timezone is whatever the laptop says.",
];
const NON_OWNER_READ = 8;
const modelCases: Array<{
  prior: number;
  statement: number;
  stored: number;
  readZone: number;
}> = process.env.ELIZA_OWNER_PROFILE_TIMEZONE_MODEL_CASES
  ? JSON.parse(
      readFileSync(
        process.env.ELIZA_OWNER_PROFILE_TIMEZONE_MODEL_CASES,
        "utf8",
      ),
    )
  : [
      { prior: -1, statement: 0, stored: 1, readZone: 1 },
      { prior: -1, statement: 1, stored: 1, readZone: 1 },
      { prior: -1, statement: 2, stored: 2, readZone: 2 },
      { prior: -1, statement: 3, stored: -1, readZone: NON_OWNER_READ },
      { prior: 0, statement: 0, stored: 1, readZone: 1 },
      { prior: 0, statement: 1, stored: 1, readZone: 1 },
      { prior: 0, statement: 2, stored: 2, readZone: 2 },
      { prior: 0, statement: 3, stored: 0, readZone: 0 },
    ];

describe("owner.profile_extraction timezone model cases", () => {
  it.each(modelCases)(
    "matches the generated owner timezone outcome (prior $prior, statement $statement)",
    async ({ prior, statement, stored, readZone }) => {
      const fresh = await createLifeOpsTestRuntime();
      try {
        if (prior >= 0) {
          await ownerSays(
            `My timezone is ${MODEL_ZONES[prior]}`,
            fresh.runtime,
          );
        }
        await ownerSays(MODEL_STATEMENTS[statement], fresh.runtime);
        const now = new Date();

        expect(await resolveConfiguredOwnerTimeZone(fresh.runtime, now)).toBe(
          stored >= 0 ? MODEL_ZONES[stored] : null,
        );
        const read = await resolveCalendarTimeZone(fresh.runtime, now);
        if (readZone === NON_OWNER_READ) {
          expect(read.source).not.toBe("owner");
        } else {
          expect(read).toEqual({
            timeZone: MODEL_ZONES[readZone],
            source: "owner",
          });
        }
      } finally {
        await fresh.cleanup();
      }
    },
    180_000,
  );
});
