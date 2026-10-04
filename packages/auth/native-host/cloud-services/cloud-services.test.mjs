import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCloudRoutes,
  createFileCredentialStore,
} from "./cloud-services.mjs";

const policy = {
  projectAccountAccess: () => ({ state: "active" }),
  createNativeCloudAuth: () => ({}),
  requireNonSensitiveText() {},
  pickMessage: (value) => ({ id: value.externalId }),
  fundingError: () => new Error("Funding unavailable"),
  planKeys: ["annual_team"],
  planCurrency: "eur",
  planInterval: "year",
  speechLanguage: "fr",
  multipartPrefix: "independent-host",
};
test("independent host selects its plan and speech policy without exposing authority", async () => {
  const calls = [];
  let checkoutMode = "embedded";
  let checkoutQuote = {
    amountDueCents: 3000,
    currency: "usd",
    interval: "month",
  };
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      createNativeCloudAuth: () => ({
        billingAuthority: () => ({
          token: "billing-session",
          expiresAt: Date.now() + 10000,
        }),
      }),
    },
    pendingCredentialStore: { read: async () => null },
    speechVoice: { voiceId: "independentVoice", modelId: "independentModel" },
    initialApiKey: "private-test-credential",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/subscriptions/plans"))
        return Response.json({
          data: {
            plans: [
              {
                active: true,
                key: "annual_team",
                name: "Annual team",
                amountCents: 1000,
                currency: "eur",
                interval: "year",
              },
              {
                active: true,
                key: "plus_monthly",
                name: "Other",
                amountCents: 1000,
                currency: "usd",
                interval: "month",
              },
            ],
          },
        });
      if (url.endsWith("/subscriptions/checkout"))
        return Response.json({
          data: {
            status: "open",
            ...checkoutQuote,
            uiMode: checkoutMode,
            clientSecret: "cs_test_checkout_secret_reviewed",
            publishableKey: "pk_test_cloudcheckout",
          },
        });
      if (url.endsWith("/voice/stt")) return Response.json({ text: "bonjour" });
      if (url.endsWith("/voice/tts"))
        return new Response(new Uint8Array([1, 2]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      throw Error("Unexpected provider request");
    },
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const plans = await (await fetch(base + "/cloud/account/plans")).json();
    assert.deepEqual(
      plans.plans.map((p) => p.key),
      ["annual_team"],
    );
    const speech = await (
      await post("/voice/stt", {
        audioBase64: Buffer.from("fixture").toString("base64"),
        mimeType: "audio/wav",
      })
    ).json();
    assert.deepEqual(speech, { text: "bonjour" });
    assert.match(
      calls.at(-1).init.rawBody ?? calls.at(-1).init.body.toString(),
      /\r\nfr\r\n/,
    );
    assert.match(
      calls.at(-1).init.headers["Content-Type"],
      /boundary=independent-host-/,
    );
    const audio = await (await post("/voice/tts", { text: "bonjour" })).json();
    assert.equal(audio.audioBase64, "AQI=");
    const sent = JSON.parse(calls.at(-1).init.body);
    assert.equal(sent.voiceId, "independentVoice");
    assert.equal(sent.modelId, "independentModel");
    assert.equal(
      calls.at(-1).init.headers.Authorization,
      "Bearer private-test-credential",
    );
    assert.doesNotMatch(
      JSON.stringify([plans, speech, audio]),
      /private-test-credential/,
    );
    const count = calls.length;
    assert.equal(
      (
        await post("/cloud/account/checkout", {
          planKey: "plus_monthly",
          presentation: "shared",
        })
      ).status,
      400,
    );
    assert.equal(calls.length, count);
    const checkoutInput = { planKey: "annual_team", presentation: "embedded" };
    const checkout = await post("/cloud/account/checkout", checkoutInput);
    assert.equal(checkout.status, 200);
    assert.deepEqual(await checkout.json(), {
      status: "open",
      uiMode: "embedded",
      clientSecret: "cs_test_checkout_secret_reviewed",
      publishableKey: "pk_test_cloudcheckout",
      amountDueCents: 3000,
      currency: "usd",
      interval: "month",
    });
    assert.equal(
      calls.at(-1).init.headers.Authorization,
      "Bearer billing-session",
    );
    for (const unsupported of [undefined, null, "elements", "unknown"]) {
      checkoutMode = unsupported;
      const response = await post("/cloud/account/checkout", checkoutInput);
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "Invalid payment response",
      });
    }
    checkoutMode = "embedded";
    checkoutQuote = { amountDueCents: 0, currency: "usd", interval: "month" };
    const zeroQuote = await post("/cloud/account/checkout", checkoutInput);
    assert.equal(zeroQuote.status, 200);
    assert.equal((await zeroQuote.json()).amountDueCents, 0);
    for (const invalidQuote of [
      { amountDueCents: undefined, currency: "usd", interval: "month" },
      { amountDueCents: -1, currency: "usd", interval: "month" },
      { amountDueCents: 0.5, currency: "usd", interval: "month" },
      {
        amountDueCents: Number.MAX_SAFE_INTEGER + 1,
        currency: "usd",
        interval: "month",
      },
      { amountDueCents: 3000, currency: "eur", interval: "month" },
      { amountDueCents: 3000, currency: "usd", interval: "year" },
    ]) {
      checkoutQuote = invalidQuote;
      const response = await post("/cloud/account/checkout", checkoutInput);
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "Invalid payment response",
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("private credential storage serializes writes and clear, and refuses symlink reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-store-"));
  const file = join(root, "credential");
  const store = createFileCredentialStore(file);
  try {
    await Promise.all([store.write("first"), store.write("second")]);
    assert.equal(await store.read(), "second");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(file, "utf8"), "second");
    await Promise.all([store.write("third"), store.clear()]);
    assert.equal(await store.read(), null);
    await symlink(join(root, "elsewhere"), file);
    await assert.rejects(store.read());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a service-only host composes CLI login and provider-default voice without billing routes", async (t) => {
  const calls = [];
  const routes = createCloudRoutes({
    hostPolicy: {
      accountBilling: false,
      providerDefaultVoice: true,
      speechLanguage: null,
      multipartPrefix: "independent-host",
      requireNonSensitiveText() {},
      pickMessage: (value) => ({ id: value.externalId }),
    },
    initialApiKey: "synthetic-credential",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/voice/tts"))
        return new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      if (url.endsWith("/voice/stt")) return Response.json({ text: "hello" });
      if (url.endsWith("/api/auth/cli-session"))
        return Response.json({
          sessionId: "12345678-1234-1234-1234-123456789012",
        });
      throw Error("Unexpected provider request");
    },
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, value) =>
    fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  for (const route of [
    "/cloud/account/access",
    "/cloud/account/plans",
    "/cloud/account/checkout",
    "/cloud/account/billing/start",
  ])
    assert.equal((await post(route, {})).status, 404);
  assert.equal(calls.length, 0);
  await assert.rejects(routes.requirePaidAccess(), /unavailable/);
  assert.equal((await post("/voice/tts", { text: "hello" })).status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { text: "hello" });
  assert.equal(
    (await post("/voice/stt", { audioBase64: "AQID", mimeType: "audio/wav" }))
      .status,
    200,
  );
  assert.doesNotMatch(calls.at(-1).options.body.toString(), /languageCode/);
  assert.equal((await post("/cloud/login", {})).status, 200);
});

test("a saved pending sign-in that becomes unparseable reports account recovery, not a service outage", async () => {
  let pendingRaw = null;
  const routes = createCloudRoutes({
    hostPolicy: policy,
    pendingCredentialStore: { read: async () => pendingRaw },
    speechVoice: { voiceId: "voice", modelId: "model" },
    initialApiKey: "private-test-credential",
    fetchImpl: async (url) => {
      if (url.endsWith("/api/v1/user")) return Response.json({ id: "user" });
      if (url.endsWith("/api/v1/billing/limits")) return Response.json({});
      throw Error("Unexpected provider request");
    },
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const healthy = await fetch(base + "/cloud/account/access");
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { state: "active" });
    // The journal corrupts after startup (partial write, editor, sync tool):
    // `ready` already resolved, so the per-request read is what sees it.
    pendingRaw = "{not json";
    const corrupted = await fetch(base + "/cloud/account/access");
    assert.equal(corrupted.status, 409);
    assert.match(
      (await corrupted.json()).error,
      /savedSignInNeedsAccountRecovery/,
    );
    const gated = await fetch(base + "/cloud/account/invoices");
    assert.equal(gated.status, 409);
    assert.match((await gated.json()).error, /savedSignInNeedsAccountRecovery/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a JSON-null saved pending sign-in stays benign across cloud routes", async () => {
  const routes = createCloudRoutes({
    hostPolicy: policy,
    pendingCredentialStore: { read: async () => "null" },
    speechVoice: { voiceId: "voice", modelId: "model" },
    initialApiKey: "private-test-credential",
    fetchImpl: async (url) => {
      if (url.endsWith("/api/v1/user")) return Response.json({ id: "user" });
      if (url.endsWith("/api/v1/billing/limits")) return Response.json({});
      if (url.endsWith("/subscriptions/plans"))
        return Response.json({ data: { plans: [] } });
      throw Error("Unexpected provider request");
    },
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await fetch(base + "/cloud/status");
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      connected: true,
      disconnectPending: false,
      credentialPersistence: "process-memory",
    });
    const access = await fetch(base + "/cloud/account/access");
    assert.equal(access.status, 200);
    assert.deepEqual(await access.json(), { state: "active" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

