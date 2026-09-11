/**
 * Verifies local chat through a real AgentRuntime, HTTP routes, and database.
 * A deterministic terminal-reply fixture supplies model output; assertions
 * require the generated reply in both the HTTP response and persisted history.
 * This smoke needs no provider credentials and does not certify live inference.
 */

import assert from "node:assert/strict";
import {
  createDeterministicModelPlugin,
  strictTerminalReplyFixture,
} from "@elizaos/core/testing";
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
  const input = "Say hello in one short sentence.";
  const expectedReply = "Hello from the deterministic model provider.";
  const modelProvider = createDeterministicModelPlugin({
    fixtures: [strictTerminalReplyFixture({ input, text: expectedReply })],
  });
  const runtimeResult = await createRealTestRuntime({
    characterName: "LocalChatCheck",
    plugins: [modelProvider],
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
      { text: input },
      undefined,
      { timeoutMs: 90_000 },
    );
    assert.equal(sent.status, 200, "message POST must return 200");
    const replyText = String(sent.data.text ?? "");
    assert.equal(
      replyText,
      expectedReply,
      "HTTP reply must match generated text",
    );
    assert.ok(
      replyText.length > 0,
      "the agent must produce a non-empty reply through the real pipeline",
    );
    // The reply must come from the real generation path — NOT the route's
    // provider-failure fallback ("Sorry, I'm having a provider issue") or an
    // ignored turn. Both of those also return HTTP 200 with non-empty text, so
    // without these checks any regression inside generateChatResponse would
    // still make this "real" proof exit 0 (false green).
    assert.equal(
      sent.data.failureKind,
      undefined,
      `chat hit the provider-failure fallback instead of a real reply: ${JSON.stringify(sent.data)}`,
    );
    assert.notEqual(
      sent.data.noResponseReason,
      "ignored",
      `agent ignored the message instead of replying: ${JSON.stringify(sent.data)}`,
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
      messages.some((m) => m.role === "assistant" && m.text === expectedReply),
      "history must contain the generated assistant reply",
    );
    modelProvider.assertFixturesConsumed();
    console.log(
      `[local-chat] PASS history persisted ${messages.length} real messages`,
    );
  } finally {
    // error-policy:J6 best-effort teardown; a cleanup failure must not mask the
    // assertion outcome that already decided this smoke's pass/fail.
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
