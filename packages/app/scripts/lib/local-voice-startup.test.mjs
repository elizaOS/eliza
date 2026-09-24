import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  LocalVoiceConversationPendingError,
  resolveLocalVoiceRuntimeIdentity,
  waitForLocalVoiceRuntimeIdentity,
} from "../../../cloud/scripts/api/local-voice-runtime-identity.ts";

const agentId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000002";

test("voice waits for the UI-owned conversation without creating one", async () => {
  let conversations = [];
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.setHeader("content-type", "application/json");
    const body =
      req.url === "/api/health"
        ? { ready: true, canRespond: true }
        : req.url === "/api/agents"
          ? { agents: [{ id: agentId, status: "running" }] }
          : { conversations };
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const runtimeOrigin = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(
      resolveLocalVoiceRuntimeIdentity({ runtimeOrigin }),
      LocalVoiceConversationPendingError,
    );
    const waiting = waitForLocalVoiceRuntimeIdentity({ runtimeOrigin });
    const creation = setTimeout(() => {
      conversations = [
        { id: conversationId, updatedAt: new Date().toISOString() },
      ];
    }, 50);
    try {
      assert.deepEqual(await waiting, {
        runtimeOrigin,
        agentId,
        conversationId,
      });
    } finally {
      clearTimeout(creation);
    }
    assert.ok(methods.every((method) => method === "GET"));
    await assert.rejects(
      waitForLocalVoiceRuntimeIdentity({
        runtimeOrigin,
        configuredConversationId: "missing",
      }),
      /configured local conversation does not exist/,
    );
    conversations = [null];
    await assert.rejects(
      waitForLocalVoiceRuntimeIdentity({ runtimeOrigin }),
      /no readable records/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
