/**
 * Exercises connected-Google account clarification with a live model and real
 * calendar persistence. Connector credentials and transport are simulated;
 * this journey does not certify external-provider access or revocation.
 */

import { isDeepStrictEqual } from "node:util";
import {
  AgentRuntime,
  activeCommittedEffectReceipts,
  getConnectorAccountManager,
  normalizeEffectReceipts,
} from "@elizaos/core";
import {
  judgeRubric,
  type ScenarioContext,
  scenario,
  toRecord,
} from "@elizaos/testing";
import { z } from "zod";
import { CalendarRepository } from "../../../../../plugin-calendar/src/service/CalendarRepository.ts";
import { seedGoogleConnectorGrant } from "../../../support/helpers/seed-grants.ts";

const beforeRows = new WeakMap<
  AgentRuntime,
  Awaited<ReturnType<CalendarRepository["listCalendarEvents"]>>
>();
const priorRequests = new WeakMap<
  AgentRuntime,
  z.infer<typeof ledgerSchema>["requests"]
>();
const ledgerSchema = z.object({
  requests: z.array(
    z
      .object({
        method: z.string(),
        path: z.string(),
        calendar: z.object({ action: z.string() }).optional(),
      })
      .passthrough(),
  ),
});
async function readGoogleRequests() {
  const base = process.env.ELIZA_MOCK_GOOGLE_BASE;
  if (!base)
    throw new Error("Google fixture server is required for write observation");
  const response = await fetch(new URL("/__mock/requests", base));
  if (!response.ok)
    throw new Error(`Google request ledger returned ${response.status}`);
  return ledgerSchema.parse(await response.json()).requests;
}
async function readCalendarRows(runtime: AgentRuntime) {
  return new CalendarRepository(runtime).listCalendarEvents(
    String(runtime.agentId),
    "eliza",
  );
}
function runtimeFor(ctx: ScenarioContext): AgentRuntime {
  if (!(ctx.runtime instanceof AgentRuntime)) {
    throw new Error("Multi-account journey requires the real scenario runtime");
  }
  return ctx.runtime;
}

export default scenario({
  lane: "live-only",
  executionProfile: "simulated",
  evidenceScope: "model-behavior",
  id: "calendar.multi-account-selection",
  title: "Two connected calendars triggers a clarification before write",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "multi-account", "clarification"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-calendar"],
    services: ["calendar"],
  },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Multi-Account Selection",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-two-accounts",
      apply: async (ctx) => {
        const runtime = runtimeFor(ctx);
        const manager = getConnectorAccountManager(runtime);
        // Exclude the simulated runtime's ambient account from this two-account case.
        for (const account of await manager.listAccounts("google")) {
          await manager.patchAccount("google", account.id, {
            status: "disabled",
          });
        }
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
          email: "personal@example.test",
          grantId: "personal-grant-1",
        });
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
          email: "work@company.test",
          grantId: "work-grant-1",
        });
        const connected = (await manager.listAccounts("google")).filter(
          (account) => account.status === "connected",
        );
        const identities = connected
          .map((account) => account.externalId)
          .sort();
        if (
          !isDeepStrictEqual(identities, [
            "personal@example.test",
            "work@company.test",
          ])
        ) {
          throw new Error(
            `Expected exactly the two declared connected Google accounts; observed ${JSON.stringify(identities)}`,
          );
        }
        // Database-backed account IDs are generated UUIDs, not seed grant labels.
        for (const account of connected) {
          await manager.patchAccount("google", account.id, {
            metadata: { ...account.metadata, isDefault: false },
          });
        }
        beforeRows.set(runtime, await readCalendarRows(runtime));
        priorRequests.set(runtime, await readGoogleRequests());
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ambiguous-add-event",
      room: "main",
      text: "Schedule a 30-minute solo focus block on my Google Calendar Friday at 3pm.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "calendar-unchanged-before-account-choice",
      predicate: async (ctx) => {
        const runtime = runtimeFor(ctx);
        const before = beforeRows.get(runtime);
        if (!before) return "Missing seeded calendar snapshot";
        for (const action of ctx.actionsCalled) {
          const raw = toRecord(action.result?.raw);
          const effects = activeCommittedEffectReceipts(
            normalizeEffectReceipts(raw?.effectReceipts),
          );
          if (
            effects.some((effect) =>
              effect.operation.startsWith("calendar.event."),
            )
          ) {
            return "Calendar mutation committed before account selection, even if later undone";
          }
        }
        const prior = priorRequests.get(runtime);
        if (!prior) return "Missing Google request ledger snapshot";
        const requests = await readGoogleRequests();
        if (!isDeepStrictEqual(requests.slice(0, prior.length), prior))
          return "Google request ledger lost prior entries";
        const writes = requests
          .slice(prior.length)
          .filter(
            (request) =>
              request.method !== "GET" &&
              /\/calendars\/[^/]+\/events(?:\/|$)/.test(request.path),
          );
        if (writes.length > 0)
          return "Google event mutation dispatched before account selection";
        const after = await readCalendarRows(runtime);
        return isDeepStrictEqual(before, after)
          ? undefined
          : "Calendar changed before the user selected a Google account";
      },
    },
    judgeRubric({
      name: "calendar-multi-account-rubric",
      threshold: 1,
      description: `The user explicitly requests a Google Calendar event and has two connected accounts with no default: personal@example.test and work@company.test. Ask which account/calendar to use before writing. Do not choose an account, substitute the built-in calendar, or claim an event was created. A clear choice between the two accounts satisfies the rubric; exact wording is not required.`,
    }),
  ],
});
