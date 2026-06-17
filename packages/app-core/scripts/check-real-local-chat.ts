/**
 * Real local chat — executed, NO secret and NO native llama. Exercises the FULL
 * real chat pipeline: a real AgentRuntime + the real conversation routes + the
 * real message-handling/RESPONSE_HANDLER flow + real history persistence. The
 * only deterministic part is token generation, supplied by the in-process
 * deterministic LLM proxy (a real Plugin with real model handlers) — NOT the
 * ui-smoke api-stub, which fakes the entire conversation endpoint and bypasses
 * the runtime. So this proves the chat machinery works end-to-end, not just that
 * a stub echoes a fixture.
 *
 * Because the proxy provides every text model + embedding handler, it needs no
 * provider/cloud key and no llama, so it runs and passes in CI without secrets.
 *
 * Run via the repo's tsx runner (real module resolution):
 *   node packages/app-core/scripts/run-node-tsx.mjs \
 *     packages/app-core/scripts/check-real-local-chat.ts
 */

import assert from "node:assert/strict";
import { createDeterministicLlmProxyPlugin } from "../../test/mocks/helpers/llm-proxy-plugin.ts";
import { startApiServer } from "../src/api/server.ts";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../test/helpers/http.ts";
import { useIsolatedConfigEnv } from "../test/helpers/isolated-config.ts";
import { createRealTestRuntime } from "../test/helpers/real-runtime.ts";

async function main(): Promise<void> {
  const t0 = Date.now();
  const configEnv = useIsolatedConfigEnv("eliza-local-chat-check-");
  // Real Plugin with real model handlers (priority 1000 wins). Deterministic
  // output; the pipeline around it is fully real.
  const proxy = createDeterministicLlmProxyPlugin({
    failOnUnhandledAction: false,
  });
  const runtimeResult = await createRealTestRuntime({
    characterName: "LocalChatCheck",
    plugins: [proxy],
  });
  const server = await startApiServer({
    port: 0,
    runtime: runtimeResult.runtime,
    skipDeferredStartupWork: true,
  });
  const { port } = server;
  console.log(`[local-chat] real API up on :${port} in ${Date.now() - t0}ms`);

  try {
    // Provision the agent so chat is enabled.
    const firstRun = await fetch(`http://127.0.0.1:${port}/api/first-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local Chat Agent" }),
    });
    assert.ok(firstRun.ok, `first-run must succeed, got ${firstRun.status}`);

    // Create a real conversation through the real route.
    const conv = await createConversation(port, { title: "real chat check" });
    assert.equal(conv.status, 200, "conversation creation must return 200");
    assert.ok(conv.conversationId, "a conversation id must be returned");
    console.log(
      `[local-chat] PASS conversation created: ${conv.conversationId}`,
    );

    // Post a user message and get the agent's reply back through the real
    // message pipeline (the POST waits for the runtime to respond).
    const sent = await postConversationMessage(
      port,
      conv.conversationId,
      { text: "Say hello in one short sentence." },
      undefined,
      { timeoutMs: 90_000 },
    );
    assert.equal(sent.status, 200, "message POST must return 200");
    const replyText = String(sent.data.text ?? "");
    assert.ok(
      replyText.length > 0,
      "the agent must produce a non-empty reply through the real pipeline",
    );
    console.log(
      `[local-chat] PASS reply via real pipeline: ${JSON.stringify(replyText.slice(0, 80))}`,
    );

    // The reply must be persisted in real conversation history.
    const hist = await req(
      port,
      "GET",
      `/api/conversations/${conv.conversationId}/messages`,
    );
    assert.equal(hist.status, 200, "history must return 200");
    const messages = (
      Array.isArray(hist.data.messages) ? hist.data.messages : []
    ) as Array<{ role?: unknown; text?: unknown }>;
    assert.ok(
      messages.some((m) => m.role === "user"),
      "history must contain the user message",
    );
    assert.ok(
      messages.some(
        (m) => m.role === "assistant" && String(m.text ?? "").length > 0,
      ),
      "history must contain a non-empty assistant reply",
    );
    console.log(
      `[local-chat] PASS history persisted ${messages.length} real messages`,
    );
  } finally {
    await server.close().catch(() => undefined);
    await runtimeResult.cleanup().catch(() => undefined);
    await configEnv.restore().catch(() => undefined);
  }

  console.log(
    `[local-chat] ALL ASSERTIONS PASSED — real local chat pipeline works (${Date.now() - t0}ms)`,
  );
}

main()
  .then(() => {
    // This is a one-shot CI proof script. After the real runtime cleanup above,
    // force the process closed so stray server/watch handles cannot hold the job
    // open until GitHub cancels it.
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      `[local-chat] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  });
