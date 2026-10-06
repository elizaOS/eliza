import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createCloudRoutes } from "./cloud-services.mjs";
import {
  createSpeechStreamSessions,
  readTimedSpeech,
} from "./timed-speech.mjs";

const frame = (sequence = 0) => ({
  type: "audio",
  sequence,
  audioBase64: "AQID",
  mimeType: "audio/mpeg",
  alignment: {
    characters: ["é", "😀"],
    characterStartTimesSeconds: [0, 0.1],
    characterEndTimesSeconds: [0.1, 0.2],
  },
  normalizedAlignment: null,
});
const done = (frames = 1) => ({ type: "done", frames, audioBytes: frames * 3 });
const headers = {
  "Content-Type": "application/x-ndjson",
  "X-Eliza-TTS-Timing": "character-v1",
};
const response = (values) =>
  new Response(values.map((v) => JSON.stringify(v)).join("\n") + "\n", {
    headers,
  });
const collect = async (iterable) => {
  const result = [];
  for await (const frame of iterable) result.push(frame);
  return result;
};

test("decoder preserves UTF-8 and frame boundaries across single-byte network fragments", async () => {
  const encoded = new TextEncoder().encode(
    JSON.stringify(frame()) + "\n" + JSON.stringify(done()) + "\n",
  );
  const result = await collect(
    readTimedSpeech(
      new Response(
        new ReadableStream({
          start(c) {
            for (const byte of encoded) c.enqueue(Uint8Array.of(byte));
            c.close();
          },
        }),
        { headers },
      ),
    ),
  );
  assert.deepEqual(result, [frame(), done()]);
});
test("decoder rejects incomplete, misordered, excess and mismatched completion data", async () => {
  for (const values of [
    [frame()],
    [frame(2), done()],
    [frame(), done(2)],
    [frame(), done(), frame(1)],
    [{ ...frame(), audioBase64: "AR==" }, done()],
    [
      {
        ...frame(),
        alignment: {
          characters: ["a"],
          characterStartTimesSeconds: [1],
          characterEndTimesSeconds: [0],
        },
      },
      done(),
    ],
  ])
    await assert.rejects(collect(readTimedSpeech(response(values))));
});
test("legacy MP3 streams remain usable without fabricated character timing", async () => {
  const frames = await collect(
    readTimedSpeech(
      new Response(Uint8Array.of(1, 2, 3), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    ),
  );
  assert.deepEqual(frames, [
    {
      type: "audio",
      sequence: 0,
      audioBase64: "AQID",
      mimeType: "audio/mpeg",
      alignment: null,
      normalizedAlignment: null,
    },
    done(),
  ]);
});
function sessions(t, options = {}) {
  let owner = "account-a",
    opens = 0;
  const service = createSpeechStreamSessions({
    open: async () => {
      opens++;
      return {
        response: response([frame(), frame(1), done(2)]),
        renderedSpeed: 0.8,
      };
    },
    assertOwner: async (expected) => {
      if (expected !== owner) throw Error("owner changed");
    },
    ...options,
  });
  t.after(() => service.close());
  return {
    service,
    owner: (value) => {
      owner = value;
    },
    opens: () => opens,
  };
}
const requestId = "request-identity-0001",
  input = { text: "Hi.", speed: 0.8 },
  owner = "account-a";
test("start and pull retries share one synthesis and replay only the original frame", async (t) => {
  const { service, opens } = sessions(t);
  const [a, b] = await Promise.all([
    service.start({ requestId, owner, input }),
    service.start({ requestId, owner, input }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(opens(), 1);
  const first = await service.pull({ streamId: a.streamId, owner, cursor: 0 });
  assert.deepEqual(
    await service.pull({ streamId: a.streamId, owner, cursor: 0 }),
    first,
  );
  const [second, retry] = await Promise.all([
    service.pull({ streamId: a.streamId, owner, cursor: 1 }),
    service.pull({ streamId: a.streamId, owner, cursor: 1 }),
  ]);
  assert.deepEqual(second, retry);
  assert.equal(second.frame.sequence, 1);
  const terminal = await service.pull({
    streamId: a.streamId,
    owner,
    cursor: 2,
  });
  assert.equal(terminal.frame.type, "done");
  assert.deepEqual(
    await service.pull({ streamId: a.streamId, owner, cursor: 2 }),
    terminal,
  );
  await assert.rejects(
    service.pull({ streamId: a.streamId, owner, cursor: 0 }),
  );
  await assert.rejects(
    service.start({ requestId, owner, input: { text: "Different" } }),
  );
  assert.equal(opens(), 1);
});
test("Stop arriving before start prevents any later synthesis of that request", async (t) => {
  const { service, opens } = sessions(t);
  await service.cancel({ requestId, owner });
  assert.equal(
    (await service.start({ requestId, owner, input })).state,
    "cancelled",
  );
  assert.equal(opens(), 0);
});
test("owner changes prevent cached audio replay and new frames", async (t) => {
  const context = sessions(t),
    a = await context.service.start({ requestId, owner, input });
  await context.service.pull({ streamId: a.streamId, owner, cursor: 0 });
  context.owner("account-b");
  await assert.rejects(
    context.service.pull({ streamId: a.streamId, owner, cursor: 0 }),
  );
  await assert.rejects(
    context.service.pull({
      streamId: a.streamId,
      owner: "account-b",
      cursor: 1,
    }),
  );
  assert.equal(context.opens(), 1);
});
test("cancellation aborts a pending read and cannot publish a late provider frame", async (t) => {
  let controller, signal;
  const { service } = sessions(t, {
    open: async (_input, s) => {
      signal = s;
      return {
        renderedSpeed: 1,
        response: new Response(
          new ReadableStream({
            start(c) {
              controller = c;
              s.addEventListener(
                "abort",
                () => c.error(Error("private-provider-data")),
                { once: true },
              );
            },
          }),
          { headers },
        ),
      };
    },
  });
  const a = await service.start({ requestId, owner, input });
  const pending = service.pull({ streamId: a.streamId, owner, cursor: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const failure = assert.rejects(pending, /Speech stream failed/);
  await service.cancel({ streamId: a.streamId, owner });
  await failure;
  assert.equal(signal.aborted, true);
  assert.equal(
    (await service.start({ requestId, owner, input })).state,
    "cancelled",
  );
  assert.ok(controller);
});
test("bounded capacity and expiry do not evict active or uncertain requests", async (t) => {
  let time = 0;
  const { service, opens } = sessions(t, {
    now: () => time,
    lifetimeMs: 1000,
    maxSessions: 2,
    maxActive: 1,
  });
  const a = await service.start({ requestId, owner, input });
  await assert.rejects(
    service.start({ requestId: "request-identity-0002", owner, input }),
    /capacity/,
  );
  await service.cancel({ streamId: a.streamId, owner });
  await service.start({ requestId: "request-identity-0002", owner, input });
  await assert.rejects(
    service.start({ requestId: "request-identity-0003", owner, input }),
    /capacity/,
  );
  assert.equal(opens(), 2);
  time = 1001;
  await assert.rejects(
    service.pull({ streamId: a.streamId, owner, cursor: 0 }),
    /unavailable/,
  );
});

async function httpHost(t, fetchImpl) {
  let credential = "private-account-a";
  const routes = createCloudRoutes({
    hostPolicy: {
      projectAccountAccess: () => ({ state: "active" }),
      createNativeCloudAuth: () => ({}),
      requireNonSensitiveText: (text) => {
        if (text.includes("private-context")) throw Error("Rejected context");
      },
      pickMessage: (value) => value,
      fundingError: () => Error("Funding unavailable"),
      planKeys: ["annual_team"],
      planCurrency: "eur",
      planInterval: "year",
      speechLanguage: "fr",
      multipartPrefix: "independent-host",
    },
    speechVoice: { voiceId: "hostVoice", modelId: "hostModel" },
    credentialStore: {
      read: async () => credential,
      write: async (value) => {
        credential = value;
      },
      clear: async () => {
        credential = null;
      },
    },
    fetchImpl,
  });
  const server = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, "http://localhost")))) {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    routes.closeSpeechStreams();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    credential: (value) => {
      credential = value;
    },
    post: async (operation, input, method = "POST") => {
      const path = operation.startsWith("/")
        ? operation
        : "/voice/tts/stream/" + operation;
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}${path}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "GET" ? {} : { body: JSON.stringify(input) }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}
test("HTTP bridge delivers before EOF, pins policy, replays lost replies and cancels on logout", async (t) => {
  let calls = 0,
    providerSignal;
  const host = await httpHost(t, async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body), {
      text: "Hi.",
      speed: 0.8,
      previousText: "Before.",
      nextText: "After.",
      applyTextNormalization: "on",
      voiceId: "hostVoice",
      modelId: "hostModel",
      withTimestamps: true,
    });
    providerSignal = init.signal;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify(frame()) + "\n"));
          init.signal.addEventListener(
            "abort",
            () => c.error(Error("private-provider-data")),
            { once: true },
          );
        },
      }),
      { headers: { ...headers, "X-Eliza-TTS-Speed": "0.8" } },
    );
  });
  const request = {
    requestId,
    ...input,
    previousText: "Before.",
    nextText: "After.",
    applyTextNormalization: "on",
  };
  const [a, b] = await Promise.all([
    host.post("start", request),
    host.post("start", request),
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(a.body.renderedSpeed, 0.8);
  const pull = { streamId: a.body.streamId, cursor: 0 };
  const first = await host.post("pull", pull);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.frame, frame());
  assert.deepEqual(await host.post("pull", pull), first);
  const pending = host.post("pull", { ...pull, cursor: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await host.post("/cloud/logout", {})).status, 200);
  const stopped = await pending;
  assert.notEqual(stopped.status, 200);
  assert.equal(providerSignal.aborted, true);
  assert.doesNotMatch(
    JSON.stringify([first, stopped, a]),
    /private-account|private-provider/,
  );
  assert.notEqual((await host.post("pull", pull)).status, 200);
  assert.equal(calls, 1);
});
test("HTTP stream admission rejects extra authority fields, context and wrong method; Stop overtakes start", async (t) => {
  let calls = 0;
  const host = await httpHost(t, async () => {
    calls++;
    return response([frame(), done()]);
  });
  for (const extra of [
    { voiceId: "rendererVoice" },
    { withTimestamps: true },
    { previousText: "private-context" },
  ])
    assert.notEqual(
      (await host.post("start", { requestId, ...input, ...extra })).status,
      200,
    );
  assert.notEqual((await host.post("start", {}, "GET")).status, 200);
  assert.equal((await host.post("cancel", { requestId })).status, 200);
  const late = await host.post("start", { requestId, ...input });
  assert.equal(late.body.state, "cancelled");
  assert.equal(calls, 0);
});
test("HTTP owner change fences retained audio and legacy MP3 does not cause a second synthesis", async (t) => {
  let calls = 0;
  const host = await httpHost(t, async () => {
    calls++;
    return new Response(Uint8Array.of(1, 2, 3), {
      headers: { "Content-Type": "audio/mpeg" },
    });
  });
  const a = await host.post("start", { requestId, ...input });
  assert.equal(a.body.renderedSpeed, null);
  const pull = { streamId: a.body.streamId, cursor: 0 };
  const first = await host.post("pull", pull);
  assert.equal(first.body.frame.audioBase64, "AQID");
  assert.equal(first.body.frame.alignment, null);
  host.credential("private-account-b");
  assert.notEqual((await host.post("pull", pull)).status, 200);
  assert.notEqual(
    (await host.post("start", { requestId, ...input })).status,
    200,
  );
  assert.equal(calls, 1);
});

test("decoder accepts the documented audio bound without regexp stack exhaustion", async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  const result = await collect(
    readTimedSpeech(
      response([
        { ...frame(), audioBase64: bytes.toString("base64"), alignment: null },
        { type: "done", frames: 1, audioBytes: bytes.length },
      ]),
    ),
  );
  assert.equal(result[0].audioBase64.length, bytes.toString("base64").length);
  assert.equal(result[1].audioBytes, bytes.length);
});

test("a sustained conversation retains terminal replay without exhausting speech after 32 clips", async (t) => {
  const { service, opens } = sessions(t);
  let first;
  for (let i = 0; i < 64; i++) {
    const started = await service.start({
      requestId: `conversation-clip-${i}`,
      owner,
      input,
    });
    if (!first) first = started;
    for (let cursor = 0; cursor <= 2; cursor++) {
      const result = await service.pull({
        streamId: started.streamId,
        owner,
        cursor,
      });
      assert.equal(result.frame.type, cursor === 2 ? "done" : "audio");
    }
  }
  assert.equal(opens(), 64);
  const replay = await service.start({
    requestId: "conversation-clip-0",
    owner,
    input,
  });
  assert.equal(replay.streamId, first.streamId);
  assert.equal(replay.state, "done");
  assert.equal(
    (await service.pull({ streamId: first.streamId, owner, cursor: 2 })).frame
      .type,
    "done",
  );
  await assert.rejects(
    service.pull({ streamId: first.streamId, owner, cursor: 0 }),
    /cursor/,
  );
  assert.equal(
    opens(),
    64,
    "old identity must not synthesize again to recover a lost reply",
  );
});
