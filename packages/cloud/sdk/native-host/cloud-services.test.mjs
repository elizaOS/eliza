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
  let checkoutSessionId = "cs_test_checkoutSession1";
  let authorized = true;
  const handled = [];
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      createNativeCloudAuth: () => ({
        // Mirrors cloud-enrollment: async, ISO expiry, null once lapsed.
        billingAuthority: async () =>
          authorized
            ? {
                token: "billing-session",
                expiresAt: new Date(Date.now() + 10000).toISOString(),
              }
            : null,
        handle: async (operation, input) => {
          handled.push({ operation, input });
          return { status: "authorized" };
        },
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
            sessionId: checkoutSessionId,
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
      if (url.endsWith("/subscriptions/checkout/confirm"))
        return Response.json({ success: true, data: { status: "open" } });
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
      sessionId: "cs_test_checkoutSession1",
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
    for (const invalidSession of [undefined, "cs_test_", "pi_test_abc", 7]) {
      checkoutSessionId = invalidSession;
      const response = await post("/cloud/account/checkout", checkoutInput);
      assert.equal(response.status, 502);
    }
    checkoutSessionId = "cs_test_checkoutSession1";
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
    const factorRoutes = {
      "/cloud/account/methods": ["account-methods", {}],
      "/cloud/account/methods/google/start": ["account-google-start", {}],
      "/cloud/account/methods/google/status": ["account-google-status", {}],
      "/cloud/account/methods/google/return": [
        "account-google-return",
        {
          callbackUrl:
            "https://product.example/link?state=synthetic&code=synthetic",
        },
      ],
      "/cloud/account/methods/google/cancel": ["account-google-cancel", {}],
      "/cloud/account/methods/google/complete": [
        "account-google-complete",
        {
          sessionId: "google-attempt",
          callbackUrl:
            "https://product.example/link?state=synthetic&code=synthetic",
        },
      ],
      "/cloud/account/methods/unlink": [
        "account-unlink",
        { reviewId: "review", methodId: "method" },
      ],
      "/cloud/account/methods/phone/start": [
        "account-phone-start",
        { phone: "+15555550123" },
      ],
      "/cloud/account/methods/phone/verify": [
        "account-phone-verify",
        { sessionId: "phone", code: "123456" },
      ],
      "/cloud/account/security/status": ["account-security-status", {}],
      "/cloud/account/security/enroll/start": [
        "account-security-enroll-start",
        { phone: "+15555550123" },
      ],
      "/cloud/account/security/enroll/verify": [
        "account-security-enroll-verify",
        { sessionId: "enrollment", code: "123456" },
      ],
      "/cloud/account/security/start": [
        "account-security-start",
        { method: "totp" },
      ],
      "/cloud/account/security/verify": [
        "account-security-verify",
        { sessionId: "security", code: "123456" },
      ],
    };
    for (const [route, [operation, input]] of Object.entries(factorRoutes)) {
      assert.equal((await post(route, input)).status, 200);
      assert.deepEqual(handled.at(-1), { operation, input });
      const before = handled.length;
      assert.equal((await fetch(base + route)).status, 404);
      assert.equal(handled.length, before);
    }
    const mfa = await post("/cloud/account/billing/mfa", {
      sessionId: "billing-attempt",
      code: "123456",
    });
    assert.equal(mfa.status, 200);
    assert.deepEqual(await mfa.json(), { status: "authorized" });
    assert.deepEqual(handled.at(-1), {
      operation: "billing-mfa",
      input: { sessionId: "billing-attempt", code: "123456" },
    });
    assert.equal(
      (await post("/cloud/account/billing/mfa", { code: "1", extra: 1 }))
        .status,
      400,
    );
    const beforeConfirm = calls.length;
    for (const invalid of [
      {},
      { sessionId: "cs_test_" },
      { sessionId: "cs_test_abc_secret_def" },
      { sessionId: "cs_test_abc", planKey: "annual_team" },
    ])
      assert.equal(
        (await post("/cloud/account/checkout/confirm", invalid)).status,
        400,
      );
    assert.equal(calls.length, beforeConfirm);
    const confirmed = await post("/cloud/account/checkout/confirm", {
      sessionId: "cs_test_checkoutSession1",
    });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), { status: "submitted" });
    assert.match(
      calls.at(-1).url,
      /\/api\/v1\/subscriptions\/checkout\/confirm$/,
    );
    assert.equal(calls.at(-1).init.method, "POST");
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
      sessionId: "cs_test_checkoutSession1",
    });
    assert.equal(
      calls.at(-1).init.headers.Authorization,
      "Bearer billing-session",
    );
    authorized = false;
    const beforeUnauthorized = calls.length;
    for (const [path, input] of [
      ["/cloud/account/checkout/confirm", { sessionId: "cs_test_abc" }],
      ["/cloud/account/checkout", checkoutInput],
    ]) {
      const response = await post(path, input);
      assert.equal(response.status, 428);
      assert.equal(
        (await response.json()).code,
        "billing_verification_required",
      );
    }
    assert.equal(calls.length, beforeUnauthorized);
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
for (const [checkoutPath, requestBody] of [
  [
    "/cloud/account/checkout",
    { planKey: "annual_team", presentation: "embedded" },
  ],
  ["/cloud/account/checkout/confirm", { sessionId: "cs_test_fixture" }],
  ["/cloud/account/portal", {}],
  [
    "/cloud/account/subscription/renewal-review",
    { subscriptionId: "11111111-1111-4111-8111-111111111111", revision: 3 },
  ],
  [
    "/cloud/account/subscription/undo",
    {
      subscriptionId: "11111111-1111-4111-8111-111111111111",
      revision: 3,
      expectedRenewalTermsDigest: "a".repeat(64),
    },
  ],
  ["/cloud/account/subscription/pending", {}],
]) {
  for (const disconnectPath of ["/cloud/logout", "/cloud/native/cancel"]) {
    test(`billing authorization retains its account epoch (${checkoutPath}, ${disconnectPath})`, async () => {
      let releaseAuthority;
      let authorityStarted;
      const started = new Promise((resolve) => {
        authorityStarted = resolve;
      });
      const held = new Promise((resolve) => {
        releaseAuthority = resolve;
      });
      let upstreamCalls = 0;
      const cancellations = [];
      const routes = createCloudRoutes({
        hostPolicy: {
          ...policy,
          createNativeCloudAuth: () => ({
            billingAuthority: async () => {
              authorityStarted();
              await held;
              return {
                token: "fixture-billing-authority",
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              };
            },
            cancel: async (options) => {
              cancellations.push(options);
              return { status: "cancelled" };
            },
          }),
        },
        pendingCredentialStore: { read: async () => null },
        speechVoice: { voiceId: "voice", modelId: "model" },
        fetchImpl: async () => {
          upstreamCalls++;
          return Response.json({ data: { status: "completed" } });
        },
      });
      const server = http.createServer((req, res) =>
        routes(req, res, new URL(req.url, "http://localhost")),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = (path, input) =>
        fetch(base + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
      try {
        const pending = post(checkoutPath, requestBody);
        await started;
        const disconnected = await post(disconnectPath, {});
        assert.equal(disconnected.status, 200);
        assert.deepEqual(cancellations, [{ disconnect: true }]);
        releaseAuthority();
        const result = await pending;
        assert.equal(result.status, 409);
        assert.match((await result.json()).error, /accountSessionChanged/);
        assert.equal(upstreamCalls, 0);
      } finally {
        releaseAuthority();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
}

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
    "/cloud/account/methods",
    "/cloud/account/methods/google/start",
    "/cloud/account/methods/google/return",
    "/cloud/account/methods/google/status",
    "/cloud/account/methods/google/complete",
    "/cloud/account/methods/google/cancel",
    "/cloud/account/security/start",
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

test("native speech rendering validates context and confirms exact provider speed", async () => {
  const calls = [];
  const screened = [];
  let speedHeader = "0.8";
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      requireNonSensitiveText(text) {
        screened.push(text);
        if (text.includes("PRIVATE"))
          throw new Error("Sensitive speech rejected");
      },
    },
    speechVoice: { voiceId: "independentVoice", modelId: "independentModel" },
    initialApiKey: "synthetic-test-key",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(new Uint8Array([1, 2]), {
        headers: {
          "Content-Type": "audio/mpeg",
          ...(speedHeader === null ? {} : { "X-Eliza-TTS-Speed": speedHeader }),
        },
      });
    },
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const post = (input) =>
    fetch(`http://127.0.0.1:${server.address().port}/voice/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  try {
    const input = {
      text: "Hello.",
      speed: 0.8,
      previousText: "Before.",
      nextText: "After.",
      applyTextNormalization: "on",
      voiceId: "untrustedVoice",
    };
    const response = await post(input);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).renderedSpeed, 0.8);
    assert.deepEqual(calls[0].body, {
      ...input,
      voiceId: "independentVoice",
      modelId: "independentModel",
    });
    assert.deepEqual(screened, ["Hello.", "Before.", "After."]);
    speedHeader = null;
    assert.equal((await (await post(input)).json()).renderedSpeed, null);
    for (const value of ["1", "0.80evil", "", "NaN", "0x0"]) {
      speedHeader = value;
      assert.equal((await post(input)).status, 502);
    }
    const count = calls.length;
    for (const controls of [
      { speed: "0.8" },
      { speed: null },
      { speed: 1.21 },
      { speed: 0.69 },
      { previousText: 1 },
      { nextText: "x".repeat(5001) },
      { applyTextNormalization: "yes" },
    ]) {
      assert.equal((await post({ text: "Hello.", ...controls })).status, 400);
    }
    for (const field of ["text", "previousText", "nextText"]) {
      assert.notEqual(
        (await post({ text: "Hello.", [field]: "PRIVATE" })).status,
        200,
      );
    }
    assert.equal(calls.length, count);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
