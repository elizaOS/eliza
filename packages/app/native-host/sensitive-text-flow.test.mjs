import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createCloudRoutes } from "./cloud-runtime-routes.mjs";
import { createLocalAgentGateway } from "./local-agent-gateway.mjs";

test("recognized secrets never cross agent or speech HTTP boundaries; safe edited draft can be sent", async (t) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const delivered = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    delivered.push(JSON.parse(raw));
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url.endsWith("/messages")
          ? { text: "Safe reply" }
          : { conversation: { id, roomId: id } },
      ),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let speechCalls = 0;
  const gateway = createLocalAgentGateway({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    token: "test-only",
    cloudHandler: createCloudRoutes({
      initialApiKey: "test-only",
      fetchImpl: async () => {
        speechCalls++;
        return new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    }),
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    gateway.closeAllConnections();
    gateway.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const post = (path, body) =>
    fetch(`http://127.0.0.1:${gateway.address().port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/conversations", {})).status, 200);
  const messages = `/conversations/${id}/messages`;
  // Public fictional canaries only. These are never real user credentials.
  for (const text of [
    "password: fictional-secret",
    "API key is sk-proj-fictional01234567890123456789",
    "verification code is 123456",
    "123456",
    "Card 4111 1111 1111 1111",
    "Bearer fictional0123456789012345",
    "-----BEGIN PRIVATE KEY-----",
    "ｐａｓｓｗｏｒｄ： fictional-secret",
  ]) {
    for (const [path, body] of [
      [messages, { text }],
      ["/voice/tts", { text }],
      ["/conversations", { title: text }],
    ]) {
      const response = await post(path, body);
      assert.equal(response.status, 422);
      const error = await response.json();
      assert.match(error.error, /It was not sent/);
      assert.ok(!error.error.includes(text));
    }
  }
  assert.equal(
    delivered.length,
    1,
    "no rejected input reached agent storage or inference",
  );
  assert.equal(speechCalls, 0, "no rejected text reached Cloud speech");
  for (const text of [
    "Help me change my password",
    "What is a verification code?",
    "My bill is $125.00",
    "Call 202-555-0134",
    "The year is 2026.",
  ]) {
    assert.equal((await post(messages, { text })).status, 200);
  }
  assert.equal(
    (await post("/voice/tts", { text: "Please use the website to sign in." }))
      .status,
    200,
  );
  assert.equal(speechCalls, 1);
});
