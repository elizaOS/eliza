/**
 * Multi-turn agent CONVERSATION journey — KEYLESS mock-LLM variant.
 *
 * The cloud-e2e suite proves provisioning (`provision.spec.ts`), app deploy
 * (`remote-app-deploy.spec.ts`), and the per-app inference-billing loop
 * (`monetized-mock-llm-journey.spec.ts` / `example-apps-showcase.spec.ts`), but
 * nothing exercised the biggest uncovered surface: a real agent holding a
 * MULTI-TURN conversation — where turn 2 depends on turn 1's context and the
 * transcript + per-turn billing persist. This spec closes that gap.
 *
 * It boots the API-only mock stack with the in-process OpenAI-compatible mock
 * LLM in CONTEXT-ECHO mode (so the reply is derived from the conversation the
 * runtime replays into the model, not a fixed string), then drives the real
 * shared-runtime (Tier-0) conversation path end to end against the live PGlite
 * DB. Only the LLM bytes are mocked; the runtime turn, the KV turn-history, the
 * REST conversation adapter, and the credit-reservation/settlement billing are
 * all the real product code.
 *
 * Journey (every value OBSERVED from the product, never supplied by the test):
 *   1. seeded user                    → org funded with real credits.
 *   2. create agent (POST .../eliza/agents) with an `openai/<model>` character
 *      so the turn routes to the mock LLM → a SHARED-tier agent.
 *   3. provision to running           → shared tier runs in-Worker; assert the
 *      persisted row is `running` and the bridge heartbeat reports ready (the
 *      shared-tier "is it live" gate; there is no control-plane provisioning job
 *      for Tier-0 — see the scope note at the bottom).
 *   4. first message                  → POST the REST conversation adapter; assert
 *      an inference reply, that the mock actually served it, a usage record with
 *      non-zero tokens, and a per-turn org credit debit.
 *   5. SECOND message (depends on #4) → same conversation; assert the reply
 *      reflects the retained first turn (echo: prior-user-turn count rises),
 *      turn 2's recorded input_tokens EXCEED turn 1's (history was replayed into
 *      the model), the persisted transcript grew to all four messages in order,
 *      and a second per-turn debit landed.
 *
 * What the mock stack does NOT support (no silent skips):
 *   - Creator EARNINGS / per-turn markup are an APP-scoped concept (X-App-Id +
 *     appCreditsService) — the agent-conversation path bills the org for
 *     inference but mints no creator markup, so there is nothing to assert there.
 *     The app earnings loop is covered by monetized-mock-llm-journey.spec.ts and
 *     example-apps-showcase.spec.ts. We assert the per-turn CREDIT DEDUCTION that
 *     genuinely applies to a conversation.
 */

import { authedClient } from "../src/helpers/monetization";
import { sendAgentBridgeRequest } from "../src/helpers/provisioning";
import { seedModelPricing } from "../src/helpers/seed-pricing";
import { expect, test } from "../src/helpers/test-fixtures";

// API-only stack + the mock LLM in context-echo mode (reply derived from the
// replayed conversation, so a multi-turn spec can assert retained context).
test.use({ stackOptions: { frontend: false, mockLlmEchoContext: true } });

// `openai/<model>` → isOpenAINativeModel → getLanguageModel honours
// OPENAI_BASE_URL → the mock LLM. The shared-runtime turn bills with no explicit
// billingSource, so `provider=openai` resolves to the `bitrouter` pricing source
// (normalizeBillingSourceCandidates) — seed THAT source below.
const MODEL = "openai/gpt-4o-mini";

// The billing path stores usage rows under the provider-stripped model name
// (`normalizeModelName` in recordUsageAnalytics), so usage queries match on this.
const USAGE_MODEL = "gpt-4o-mini";

interface CreateAgentEnvelope {
  success?: boolean;
  data?: {
    id?: string;
    agentId?: string;
    status?: string;
    executionTier?: string;
  };
}

interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface MessagesGetEnvelope {
  messages?: ConversationMessage[];
}

interface MessageSendEnvelope {
  text?: string;
  agentName?: string;
}

interface BalanceResponse {
  balance?: number;
}

/**
 * The org's `chat` usage rows for {@link MODEL}, newest-first. Dynamic import
 * (matching the suite's mock-LLM specs) so the cloud-shared DB graph isn't pulled
 * in at Playwright collection time.
 */
async function chatUsageRows(
  orgId: string,
): Promise<
  Array<{ inputTokens: number; outputTokens: number; model: string | null }>
> {
  const { usageRecordsRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/usage-records"
  );
  const rows = await usageRecordsRepository.listByOrganization(orgId, 50);
  return rows
    .filter((r) => r.type === "chat" && r.model === USAGE_MODEL)
    .map((r) => ({
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      model: r.model,
    }));
}

test.describe("multi-turn agent conversation (mock LLM, keyless)", () => {
  test("seeded user creates an agent → holds a two-turn conversation → context + transcript + per-turn billing persist", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;
    expect(
      stack.urls.mockLlm,
      "stack booted with the mock LLM wired in",
    ).toBeTruthy();

    // Shared-runtime billing resolves provider=openai → billingSource bitrouter.
    await seedModelPricing({
      model: MODEL,
      billingSource: "bitrouter",
      provider: "openai",
    });

    const c = authedClient(api, seededUser.apiKey);

    // ── 1+2. create the agent with an openai/<model> character. ───────────────
    const created = await c<CreateAgentEnvelope>(
      "POST",
      "/api/v1/eliza/agents",
      {
        agentName: `Convo Agent ${Date.now().toString(36)}`,
        agentConfig: {
          character: {
            name: "Convo",
            system:
              "You are Convo, a helpful assistant who remembers the conversation.",
            model: MODEL,
          },
        },
      },
    );
    expect([200, 201]).toContain(created.status);
    const agentId = created.json.data?.id ?? created.json.data?.agentId;
    expect(agentId, "agent create returns an id").toBeTruthy();
    if (!agentId) throw new Error("agent create did not return an id");
    // A plain chat agent is a SHARED (Tier-0) runtime — runs in-Worker, no
    // dedicated container/provisioning job.
    expect(
      created.json.data?.executionTier,
      "plain chat agent is a shared-tier runtime",
    ).toBe("shared");

    // ── 3. provision to running — shared tier is running on create. Assert the
    //       persisted state AND the live bridge heartbeat before messaging. ────
    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    const persisted = await agentSandboxesRepository.findByIdAndOrg(
      agentId,
      seededUser.organizationId,
    );
    expect(persisted?.status, "agent is persisted as running").toBe("running");
    expect(persisted?.execution_tier).toBe("shared");

    const heartbeat = await sendAgentBridgeRequest(
      { apiUrl: api },
      seededUser.apiKey,
      agentId,
      { jsonrpc: "2.0", id: "hb", method: "heartbeat" },
    );
    expect(
      heartbeat.result,
      "bridge heartbeat reports the shared runtime ready",
    ).toMatchObject({ status: "running", ready: true, runtime: "shared" });

    // The canonical single conversation for a shared agent is conversationId ===
    // agentId (the REST adapter's launch model). Drive both turns through it so
    // they land in the same KV channel and the transcript reads back coherently.
    const convoUrl = `/api/v1/eliza/agents/${agentId}/api/conversations/${agentId}/messages`;

    const balanceStart =
      (await c<BalanceResponse>("GET", "/api/v1/credits/balance")).json
        .balance ?? 0;
    expect(balanceStart, "org starts funded").toBeGreaterThan(0);

    // ── 4. first message. ─────────────────────────────────────────────────────
    const FIRST = "My favorite color is teal. Remember that.";
    const turn1 = await c<MessageSendEnvelope>("POST", convoUrl, {
      text: FIRST,
    });
    expect(turn1.status, "first message accepted").toBe(200);
    expect(
      turn1.json.text,
      "first turn produced an assistant reply",
    ).toBeTruthy();
    // Echo mode: turn 1 has the user message and zero PRIOR user turns.
    expect(
      turn1.json.text,
      "turn 1 reply reflects exactly this turn (no prior context yet)",
    ).toBe(`turn 1 (prior user turns: 0): ${FIRST}`);

    // The mock actually served the inference (the runtime turn ran for real).
    expect(
      stack.mocks.mockLlm?.requestCount() ?? 0,
      "the mock LLM served the first turn",
    ).toBe(1);

    // A usage record with non-zero tokens was recorded for the turn.
    const usageAfter1 = await chatUsageRows(seededUser.organizationId);
    expect(usageAfter1.length, "one chat usage record after turn 1").toBe(1);
    expect(
      usageAfter1[0].outputTokens,
      "turn 1 recorded non-zero output tokens",
    ).toBeGreaterThan(0);
    expect(
      usageAfter1[0].inputTokens,
      "turn 1 recorded non-zero input tokens",
    ).toBeGreaterThan(0);

    // The org was debited for the turn (real reservation→settlement billing).
    const balanceAfter1 =
      (await c<BalanceResponse>("GET", "/api/v1/credits/balance")).json
        .balance ?? 0;
    const debit1 = balanceStart - balanceAfter1;
    console.log(
      `[multi-turn] turn 1 debit ${debit1} (before=${balanceStart} after=${balanceAfter1})`,
    );
    expect(debit1, "turn 1 debited the org for inference").toBeGreaterThan(0);

    // ── 5. second message — depends on turn 1's context. ──────────────────────
    const SECOND = "What did I say my favorite color was?";
    const turn2 = await c<MessageSendEnvelope>("POST", convoUrl, {
      text: SECOND,
    });
    expect(turn2.status, "second message accepted").toBe(200);
    // The reply reflects the RETAINED first turn: the runtime replayed the prior
    // turn into the model, so the echo's prior-user-turn count rose to 1. A fixed
    // reply (or a fresh, context-less turn) could not produce this.
    expect(
      turn2.json.text,
      "turn 2 reply reflects retained context (one prior user turn replayed)",
    ).toBe(`turn 2 (prior user turns: 1): ${SECOND}`);

    expect(
      stack.mocks.mockLlm?.requestCount() ?? 0,
      "the mock LLM served the second turn too",
    ).toBe(2);

    // Token-level proof of context retention: turn 2's recorded input tokens
    // EXCEED turn 1's, because the prompt now carries the prior turn's transcript.
    const usageAfter2 = await chatUsageRows(seededUser.organizationId);
    expect(usageAfter2.length, "two chat usage records after turn 2").toBe(2);
    // listByOrganization is newest-first → [turn2, turn1].
    const [t2Usage, t1Usage] = usageAfter2;
    expect(
      t2Usage.inputTokens,
      "turn 2 billed MORE input tokens than turn 1 (history replayed into the model)",
    ).toBeGreaterThan(t1Usage.inputTokens);

    // ── conversation/message history persisted: the full ordered transcript. ──
    const history = await c<MessagesGetEnvelope>("GET", convoUrl);
    expect(history.status, "transcript readable").toBe(200);
    const msgs = history.json.messages ?? [];
    expect(
      msgs.length,
      "persisted transcript has both turns (user+assistant ×2)",
    ).toBe(4);
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(msgs[0].text, "turn 1 user message persisted").toBe(FIRST);
    expect(msgs[1].text, "turn 1 assistant reply persisted").toBe(
      turn1.json.text,
    );
    expect(msgs[2].text, "turn 2 user message persisted").toBe(SECOND);
    expect(msgs[3].text, "turn 2 assistant reply persisted").toBe(
      turn2.json.text,
    );

    // ── per-turn billing: the second turn debited the org again. ──────────────
    const balanceAfter2 =
      (await c<BalanceResponse>("GET", "/api/v1/credits/balance")).json
        .balance ?? 0;
    const debit2 = balanceAfter1 - balanceAfter2;
    console.log(
      `[multi-turn] turn 2 debit ${debit2} (after1=${balanceAfter1} after2=${balanceAfter2})`,
    );
    expect(
      debit2,
      "turn 2 debited the org again (per-turn billing)",
    ).toBeGreaterThan(0);
    expect(
      balanceAfter2,
      "two turns dropped the balance below the one-turn balance",
    ).toBeLessThan(balanceAfter1);
  });
});
