import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createCloudRoutes } from "./cloud-services.mjs";

async function host(t, fetchImpl, signal) {
  const routes = createCloudRoutes({
    hostPolicy: {
      projectAccountAccess: () => ({ state: "active" }),
      createNativeCloudAuth: () => ({}),
      requireNonSensitiveText() {},
      pickMessage: (value) => value,
      fundingError: () => Error("Funding unavailable"),
      planKeys: ["annual_team"],
      planCurrency: "eur",
      planInterval: "year",
      speechLanguage: "fr",
      multipartPrefix: "independent-host",
    },
    speechVoice: { voiceId: "hostVoice", modelId: "hostModel" },
    initialApiKey: "synthetic-account-key",
    fetchImpl,
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost"), { signal }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    routes.closeSpeechStreams();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return async (path, input = {}, method = "POST") => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(input) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
}
const warming = (wait = "0", code = "auth_cache_warming", status = 503) =>
  Response.json(
    { error: { code } },
    { status, headers: { "Retry-After": wait } },
  );
const audio = () =>
  new Response(Uint8Array.of(1, 2), {
    headers: { "Content-Type": "audio/mpeg" },
  });

for (const operation of ["tts", "stt", "tts/stream/start"]) {
  test(`native ${operation} recovers a cold auth cache without replaying admitted speech`, async (t) => {
    const calls = [];
    const post = await host(t, async (url, init) => {
      calls.push({
        url,
        authorization: init.headers.Authorization,
        body:
          typeof init.body === "string" ? init.body : Buffer.from(init.body),
      });
      if (calls.length === 1) return warming();
      return operation === "stt" ? Response.json({ text: "Bonjour" }) : audio();
    });
    const input =
      operation === "stt"
        ? { audioBase64: "AQI=", mimeType: "audio/wav" }
        : {
            text: "Bonjour",
            ...(operation.includes("stream")
              ? { requestId: "synthetic-request-0001" }
              : {}),
          };
    const result = await post(`/voice/${operation}`, input);
    assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    if (operation === "stt") assert.equal(result.body.text, "Bonjour");
    else if (operation === "tts") assert.equal(result.body.audioBase64, "AQI=");
    else {
      const pull = await post("/voice/tts/stream/pull", {
        streamId: result.body.streamId,
        cursor: 0,
      });
      assert.equal(pull.status, 200);
      assert.equal(pull.body.frame.audioBase64, "AQI=");
      assert.equal(calls.length, 2);
    }
  });
}

test("native speech retries are bounded; other statuses, malformed hints, large bodies and unrelated operations never retry", async (t) => {
  for (const entry of [
    { make: () => warming(), count: 3 },
    { make: () => warming("Thu, 01 Jan 1970 00:00:00 GMT"), count: 3 },
    { make: () => warming("10"), count: 1 },
    { make: () => warming("1.5"), count: 1 },
    { make: () => warming("invalid"), count: 1 },
    { make: () => warming("0", "billing_cache_warming"), count: 1 },
    { make: () => warming("0", "auth_cache_warming", 429), count: 1 },
    { make: () => warming("0", "auth_cache_warming", 401), count: 1 },
    {
      make: () =>
        new Response("not json", {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      count: 1,
    },
    {
      make: () =>
        Response.json(
          { code: "auth_cache_warming", extra: "x".repeat(17000) },
          { status: 503 },
        ),
      count: 1,
    },
    {
      make: () => {
        throw Error("synthetic-network-failure");
      },
      count: 1,
    },
  ]) {
    let calls = 0;
    const post = await host(t, async () => {
      calls++;
      return entry.make();
    });
    assert.notEqual(
      (await post("/voice/tts", { text: "Bonjour" })).status,
      200,
    );
    assert.equal(calls, entry.count);
  }
  let calls = 0;
  const post = await host(t, async () => {
    calls++;
    return warming();
  });
  assert.equal((await post("/cloud/account/invoices", {}, "GET")).status, 503);
  assert.equal(calls, 1);
});

test("native speech honors Retry-After and cancels warming on abort or account replacement", async (t) => {
  for (const change of ["abort", "logout", "none"]) {
    const controller = new AbortController();
    const times = [];
    const post = await host(
      t,
      async () => {
        times.push(performance.now());
        return times.length === 1 ? warming("1") : audio();
      },
      controller.signal,
    );
    const pending = post("/voice/tts", { text: "Bonjour" });
    while (times.length === 0) await sleep(1);
    if (change === "abort") controller.abort();
    if (change === "logout")
      assert.equal((await post("/cloud/logout")).status, 200);
    const result = await pending;
    assert.equal(times.length, change === "none" ? 2 : 1);
    if (change === "none") {
      assert.equal(result.status, 200);
      assert.ok(times[1] - times[0] >= 990);
    } else assert.notEqual(result.status, 200);
  }
});

test("native admitted stream outlives the warming deadline and still cancels on logout", async (t) => {
  let calls = 0;
  let providerSignal;
  const post = await host(t, async (_url, init) => {
    if (++calls === 1) return warming();
    providerSignal = init.signal;
    return audio();
  });
  const result = await post("/voice/tts/stream/start", {
    text: "Bonjour",
    requestId: "synthetic-request-0001",
  });
  assert.equal(result.status, 200);
  await sleep(10020);
  assert.equal(providerSignal.aborted, false);
  assert.equal((await post("/cloud/logout")).status, 200);
  assert.equal(providerSignal.aborted, true);
  assert.equal(calls, 2);
});
