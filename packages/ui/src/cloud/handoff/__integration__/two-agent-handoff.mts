/**
 * Live two-agent handoff integration test.
 *
 * Drives the REAL `runConversationHandoff` orchestrator against two booted local
 * agents standing in for the shared (A) and personal (B) cloud agents:
 *   read A's conversation → import into B (silent) → "switch" → verify B has it.
 *
 * Run (with agent A on :41339 holding conversation `handoff-test-conv-1` and
 * agent B on :41340):
 *   node packages/app-core/scripts/run-node-tsx.mjs \
 *     packages/ui/src/cloud/handoff/__integration__/two-agent-handoff.mts
 */
import {
  runConversationHandoff,
  toHandoffMessages,
} from "../conversation-handoff.ts";

const SHARED = "http://127.0.0.1:41339";
const PERSONAL = "http://127.0.0.1:41340";
const CONV = "handoff-test-conv-1";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return (await res.json()) as Record<string, unknown>;
}

let switched = false;

const result = await runConversationHandoff({
  intervalMs: 2_000,
  timeoutMs: 120_000,
  checkPersonalReady: async () => {
    try {
      const h = await getJson(`${PERSONAL}/api/health`);
      return { ready: h.ready === true, apiBase: PERSONAL };
    } catch {
      return { ready: false };
    }
  },
  readSharedMessages: async () => {
    const body = await getJson(`${SHARED}/api/conversations/${CONV}/messages`);
    const raw = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
      : [];
    return toHandoffMessages(raw);
  },
  importToPersonal: async (messages) => {
    const res = await fetch(`${PERSONAL}/api/conversations/${CONV}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Migrated from shared", messages }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as {
      inserted?: number;
      alreadyPopulated?: boolean;
    };
    return {
      inserted: json.inserted ?? 0,
      alreadyPopulated: json.alreadyPopulated,
    };
  },
  switchToPersonal: () => {
    switched = true;
  },
  log: (m) => console.log(`  ${m}`),
});

console.log("\n=== handoff result ===");
console.log(JSON.stringify(result, null, 2));

assert(result.status === "switched", "handoff status is 'switched'");
assert(result.imported === 4, `imported 4 messages (got ${result.imported})`);
assert(switched, "switchToPersonal was invoked");

// Verify the personal agent (B) now holds the migrated conversation in order.
const personalBody = await getJson(
  `${PERSONAL}/api/conversations/${CONV}/messages`,
);
const personalMsgs = (
  Array.isArray(personalBody.messages) ? personalBody.messages : []
) as Array<{ role: string; text: string }>;
console.log("\n=== personal agent conversation after handoff ===");
for (const m of personalMsgs) console.log(`  ${m.role} | ${m.text}`);

assert(
  personalMsgs.length === 4,
  `personal has 4 messages (got ${personalMsgs.length})`,
);
assert(
  personalMsgs.map((m) => m.role).join(",") === "user,assistant,user,assistant",
  "roles preserved in order",
);
assert(
  personalMsgs[0]?.text === "hello from the shared agent" &&
    personalMsgs[3]?.text === "yes, seamlessly",
  "first + last message text preserved",
);

// Idempotency: re-running the handoff must not duplicate.
const second = await runConversationHandoff({
  intervalMs: 1_000,
  timeoutMs: 30_000,
  checkPersonalReady: async () => ({ ready: true, apiBase: PERSONAL }),
  readSharedMessages: async () => {
    const body = await getJson(`${SHARED}/api/conversations/${CONV}/messages`);
    return toHandoffMessages(
      Array.isArray(body.messages)
        ? (body.messages as Array<Record<string, unknown>>)
        : [],
    );
  },
  importToPersonal: async (messages) => {
    const res = await fetch(`${PERSONAL}/api/conversations/${CONV}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as {
      inserted?: number;
      alreadyPopulated?: boolean;
    };
    return {
      inserted: json.inserted ?? 0,
      alreadyPopulated: json.alreadyPopulated,
    };
  },
  switchToPersonal: () => {},
});
const afterBody = await getJson(
  `${PERSONAL}/api/conversations/${CONV}/messages`,
);
const afterCount = (Array.isArray(afterBody.messages) ? afterBody.messages : [])
  .length;
assert(second.imported === 0, "re-run imported 0 (idempotent)");
assert(
  afterCount === 4,
  `personal still has 4 messages after re-run (got ${afterCount})`,
);

console.log(
  failures === 0
    ? "\nTWO-AGENT HANDOFF INTEGRATION PASSED"
    : `\nFAILED (${failures} assertion(s))`,
);
process.exit(failures === 0 ? 0 : 1);
