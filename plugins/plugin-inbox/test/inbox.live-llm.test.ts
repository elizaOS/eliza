/**
 * LIVE real-LLM test for inbox triage.
 *
 * Unlike `inbox.real-db.test.ts` (which registers a DETERMINISTIC rule-based
 * fake TEXT_SMALL model so it is hermetic), this suite registers a REAL model
 * handler backed by a local OpenAI-compatible LLM endpoint (Ollama by default)
 * and drives the production inbox triage classifier end-to-end with it: real
 * prompt → real model → real JSON parse → real classification. It is the
 * "live real testing" counterpart of the recorded/contract tests — exercising
 * the decomposed plugin's LLM path against an actual model, no mock.
 *
 * Gated like the other live tests (`describe.skipIf(!LIVE)`): it SKIPS by
 * default and runs only when `INBOX_LLM_LIVE_TEST=1` (or the post-merge lane),
 * with a reachable endpoint. No external credentials — uses a LOCAL model.
 *
 *   INBOX_LLM_LIVE_TEST=1 bun run --cwd plugins/plugin-inbox test inbox.live-llm
 *
 * Endpoint/model overridable via OLLAMA_BASE_URL (default
 * http://127.0.0.1:11434/v1) and OLLAMA_MODEL (default gpt-4o-mini).
 */

import {
  type AgentRuntime,
  ModelType,
  type ModelTypeName,
  type Plugin,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
import {
  lifeInboxTriageEntries,
  lifeInboxTriageExamples,
} from "../../plugin-personal-assistant/src/lifeops/schema.ts";
import { InboxService } from "../src/inbox/service.ts";
import type { InboundMessage } from "../src/inbox/types.ts";

const LIVE =
  process.env.INBOX_LLM_LIVE_TEST === "1" ||
  process.env.TEST_LANE === "post-merge";

const BASE_URL = (
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1"
).replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL ?? "gpt-4o-mini";

/** Call the local OpenAI-compatible chat endpoint and return the text. */
async function callLocalLlm(prompt: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

const inboxSchemaPlugin: Plugin = {
  name: "@elizaos/plugin-personal-assistant",
  description: "Test-only inbox triage table bootstrap.",
  schema: { lifeInboxTriageEntries, lifeInboxTriageExamples },
};

function inbound(
  overrides: Partial<InboundMessage> & { id: string; text: string },
): InboundMessage {
  return {
    source: "discord",
    senderName: "Test Sender",
    channelName: "general",
    channelType: "dm",
    snippet: overrides.text.slice(0, 80),
    timestamp: Date.now(),
    ...overrides,
  };
}

describe.skipIf(!LIVE)("InboxService triage — LIVE local LLM", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: InboxService;

  beforeAll(async () => {
    // Fail loudly (not silently skip) if the gate is on but the endpoint is
    // unreachable — the operator asked for a live run.
    const probe = await callLocalLlm("Reply with the single word OK.").catch(
      (e) => {
        throw new Error(
          `INBOX_LLM_LIVE_TEST=1 but ${BASE_URL} (${MODEL}) is unreachable: ${e instanceof Error ? e.message : String(e)}`,
        );
      },
    );
    expect(probe.length).toBeGreaterThan(0);

    testResult = await createRealTestRuntime({
      characterName: "inbox-live-llm-tests",
      plugins: [inboxSchemaPlugin],
    });
    runtime = testResult.runtime;

    // REAL model: forward the classifier's prompt to the local LLM.
    runtime.registerModel(
      ModelType.TEXT_SMALL as ModelTypeName,
      async (_rt, params) =>
        callLocalLlm(String((params as { prompt?: string }).prompt)),
      "inbox-live-llm",
      100,
    );

    service = new InboxService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  // A single, unambiguous message: the production classifier (real prompt →
  // real model → real JSON parse → strict enum validation) must classify an
  // outage as urgent. Single-message keeps the assertion reliable against a
  // small local model's output variance — the goal is to prove the decomposed
  // plugin's LLM path executes live and correctly, not to benchmark the model.
  it("a real local LLM classifies an obvious outage as urgent (live, end-to-end)", async () => {
    const result = await service.triage(
      [
        inbound({
          id: "live-urgent",
          senderName: "Ops",
          text: "URGENT: production database is down, all customers cannot log in. Please respond ASAP.",
        }),
      ],
      { classifyOnly: true },
    );

    expect(result.triaged).toHaveLength(1);
    const urgent = result.triaged[0];
    // Real LLM output flowed through the production parser + enum validation.
    expect(urgent?.classification).toBe("urgent");
    expect(urgent?.urgency).toBe("high");
    expect(urgent?.confidence).toBeGreaterThanOrEqual(0);
    expect(urgent?.confidence).toBeLessThanOrEqual(1);
  }, 120_000);

  // A clear no-action message: proves the live path discriminates (not every
  // message is urgent) — newsletters are never urgent.
  it("a real local LLM does not mark a newsletter urgent (live)", async () => {
    const result = await service.triage(
      [
        inbound({
          id: "live-newsletter",
          source: "gmail",
          senderName: "Marketing Weekly",
          text: "This week's newsletter: 10 productivity tips and a recipe. Unsubscribe at the bottom.",
        }),
      ],
      { classifyOnly: true },
    );

    expect(result.triaged).toHaveLength(1);
    expect(result.triaged[0]?.classification).not.toBe("urgent");
  }, 120_000);
});
