/** Exercises the real gateway child and HTTP identity boundary through first-chat creation and shutdown. */
import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { waitForLocalVoiceRuntimeIdentity } from "../../scripts/api/local-voice-runtime-identity.ts";

const agentId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000002";
const gatewayScript = fileURLToPath(
  new URL("../../scripts/api/local-voice-gateway.ts", import.meta.url),
);

function runtimeFixture() {
  let conversations: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/api/health":
          return Response.json({ ready: true, canRespond: true });
        case "/api/agents":
          return Response.json({
            agents: [{ id: agentId, status: "running" }],
          });
        case "/api/conversations":
          return Response.json({ conversations });
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });
  return {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    createConversation() {
      conversations = [
        { id: conversationId, updatedAt: new Date().toISOString() },
      ];
    },
    corruptConversations() {
      conversations = [null];
    },
  };
}

async function until(condition: () => boolean, detail: () => string) {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error(`Gateway condition timed out: ${detail()}`);
    await delay(25);
  }
}

function launchGateway(origin: string, configuredConversationId?: string) {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = reservation.port;
  reservation.stop(true);
  const child = Bun.spawn(
    [process.execPath, "--conditions=eliza-source", gatewayScript],
    {
      env: {
        ...process.env,
        CARTESIA_API_KEY: "local-lifecycle-test-no-provider-calls",
        ELIZA_LOCAL_API_ORIGIN: origin,
        ELIZA_LOCAL_VOICE_GATEWAY_PORT: String(port),
        ELIZA_LOCAL_VOICE_AGENT_ID: undefined,
        ELIZA_LOCAL_VOICE_CONVERSATION_ID: configuredConversationId,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let log = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) log += new TextDecoder().decode(chunk);
  };
  const drained = Promise.all([read(child.stdout), read(child.stderr)]);
  return {
    child,
    port,
    log: () => log,
    drained,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      await drained;
    },
  };
}

test("gateway waits for first chat, starts once without relaunch, then releases its listener", async () => {
  const runtime = runtimeFixture();
  const gateway = launchGateway(runtime.origin);
  try {
    await until(
      () =>
        gateway
          .log()
          .includes("waiting for the local runtime's first conversation"),
      gateway.log,
    );
    expect(gateway.child.exitCode).toBeNull();
    expect(gateway.log()).not.toContain("gateway ready");
    runtime.createConversation();
    await until(
      () => gateway.log().includes("Cartesia realtime voice gateway ready"),
      gateway.log,
    );
    expect(
      gateway.log().match(/Cartesia realtime voice gateway ready/g),
    ).toHaveLength(1);
    const response = await fetch(
      `http://127.0.0.1:${gateway.port}/api/v1/voice/session/health?conversationId=${conversationId}`,
    );
    expect(response.ok).toBe(true);
    await gateway.stop();
    expect(gateway.child.exitCode).toBe(0);
    await expect(
      fetch(`http://127.0.0.1:${gateway.port}/api/v1/voice/session/health`),
    ).rejects.toThrow();
  } finally {
    await gateway.stop();
    runtime.server.stop(true);
  }
}, 40_000);

test("stopping a pending gateway does not launch a server after a conversation arrives", async () => {
  const runtime = runtimeFixture();
  const gateway = launchGateway(runtime.origin);
  try {
    await until(
      () =>
        gateway
          .log()
          .includes("waiting for the local runtime's first conversation"),
      gateway.log,
    );
    await gateway.stop();
    runtime.createConversation();
    expect(gateway.log()).not.toContain("gateway ready");
    await expect(
      fetch(`http://127.0.0.1:${gateway.port}/api/v1/voice/session/health`),
    ).rejects.toThrow();
  } finally {
    await gateway.stop();
    runtime.server.stop(true);
  }
}, 40_000);

test("an explicitly configured missing conversation fails instead of waiting", async () => {
  const runtime = runtimeFixture();
  const gateway = launchGateway(runtime.origin, conversationId);
  try {
    expect(await gateway.child.exited).toBe(1);
    await gateway.drained;
    expect(gateway.log()).toContain(
      "configured local conversation does not exist",
    );
    expect(gateway.log()).not.toContain("waiting for");
  } finally {
    await gateway.stop();
    runtime.server.stop(true);
  }
}, 40_000);

test("malformed conversation records are errors, not first-chat readiness", async () => {
  const runtime = runtimeFixture();
  runtime.corruptConversations();
  try {
    await expect(
      waitForLocalVoiceRuntimeIdentity({ runtimeOrigin: runtime.origin }),
    ).rejects.toThrow("no readable records");
  } finally {
    runtime.server.stop(true);
  }
});

test("a configured agent mismatch remains an error while no conversation exists", async () => {
  const runtime = runtimeFixture();
  try {
    await expect(
      waitForLocalVoiceRuntimeIdentity({
        runtimeOrigin: runtime.origin,
        configuredAgentId: conversationId,
      }),
    ).rejects.toThrow("configured local agent does not exist");
  } finally {
    runtime.server.stop(true);
  }
});

test("a pending identity wait can be aborted", async () => {
  const runtime = runtimeFixture();
  const controller = new AbortController();
  try {
    const pending = waitForLocalVoiceRuntimeIdentity({
      runtimeOrigin: runtime.origin,
      signal: controller.signal,
      onWaiting: () => controller.abort(),
    });
    await expect(pending).rejects.toThrow();
  } finally {
    runtime.server.stop(true);
  }
});
