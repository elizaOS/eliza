import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeCloudAuth as createEnrollment } from "../../../auth/native-host/cloud-enrollment.mjs";
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
      speechLanguages: ["en", "es"],
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
                allowance: {
                  amountUsd: "25.000000",
                  fundingClass: "allowance_eligible",
                  rollover: false,
                  expiresAt: "billing_period_end",
                  internalNote: "never relayed",
                },
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
    // The allowance terms come through as the catalog states them, and
    // nothing else does.
    assert.deepEqual(plans.plans[0].allowance, {
      amountUsd: "25.000000",
      fundingClass: "allowance_eligible",
      rollover: false,
      expiresAt: "billing_period_end",
    });
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
    // The same host serves people who select different languages. Overrides
    // apply to one capture; an omitted language keeps the host's default.
    for (const languageCode of ["es", "en", undefined]) {
      const response = await post("/voice/stt", {
        audioBase64: "AQID",
        mimeType: "audio/wav",
        ...(languageCode === undefined ? {} : { languageCode }),
      });
      assert.equal(response.status, 200);
      const form = await new Response(calls.at(-1).init.body, {
        headers: { "Content-Type": calls.at(-1).init.headers["Content-Type"] },
      }).formData();
      assert.equal(form.get("languageCode"), languageCode ?? "fr");
      assert.deepEqual(
        new Uint8Array(await form.get("audio").arrayBuffer()),
        new Uint8Array([1, 2, 3]),
      );
    }
    const beforeInvalidLanguage = calls.length;
    for (const languageCode of [
      "de",
      "es\r\nInjected: true",
      null,
      42,
      ["es"],
    ]) {
      const response = await post("/voice/stt", {
        audioBase64: "AQID",
        mimeType: "audio/wav",
        languageCode,
      });
      assert.equal(response.status, 400);
    }
    assert.equal(
      calls.length,
      beforeInvalidLanguage,
      "Unapproved languages never reach the provider",
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
        // Logout disconnects; a sign-in cancel drops only the pending sign-in.
        assert.deepEqual(
          cancellations,
          disconnectPath === "/cloud/logout"
            ? [{ disconnect: true }]
            : [undefined],
        );
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

test("billing confirmation start forwards only the verification purpose to native auth", async (t) => {
  const handled = [];
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      createNativeCloudAuth: () => ({
        billingAuthority: async () => null,
        handle: async (operation, input) => {
          handled.push({ operation, input });
          return { status: "sent", sessionId: "fixture-session" };
        },
      }),
    },
    pendingCredentialStore: { read: async () => null },
    speechVoice: { voiceId: "voice", modelId: "model" },
    fetchImpl: async () => {
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
  assert.equal((await post("/cloud/account/billing/start", {})).status, 200);
  assert.equal(
    (await post("/cloud/account/billing/start", { purpose: "account" })).status,
    200,
  );
  assert.deepEqual(handled, [
    { operation: "billing-start", input: {} },
    { operation: "billing-start", input: { purpose: "account" } },
  ]);
  for (const [route, value] of [
    ["/cloud/account/billing/start", { purpose: "account", sessionId: "x" }],
    [
      "/cloud/account/billing/verify",
      { sessionId: "x", code: "1", purpose: "account" },
    ],
  ])
    assert.equal((await post(route, value)).status, 400);
  assert.equal(handled.length, 2);
});

test("a sign-in 429 answer carries the reported wait in seconds, and nothing invented", async (t) => {
  const failures = [
    Object.assign(new Error("Too many attempts."), {
      status: 429,
      retryAfter: 42,
    }),
    Object.assign(new Error("Too many attempts."), { status: 429 }),
    // Only a 429 says how long to wait.
    Object.assign(new Error("Unavailable."), { status: 503, retryAfter: 9 }),
  ];
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      createNativeCloudAuth: () => ({
        handle: async () => {
          throw failures.shift();
        },
        cancel: async () => ({ status: "cancelled" }),
      }),
    },
    pendingCredentialStore: { read: async () => null },
    speechVoice: { voiceId: "voice", modelId: "model" },
    fetchImpl: async () => {
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
  const start = () =>
    fetch(`http://127.0.0.1:${server.address().port}/cloud/native/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "synthetic@example.com" }),
    });
  const waited = await start();
  assert.equal(waited.status, 429);
  assert.deepEqual(await waited.json(), {
    error: "Too many attempts.",
    retryAfter: 42,
  });
  const unsaid = await start();
  assert.equal(unsaid.status, 429);
  assert.deepEqual(await unsaid.json(), { error: "Too many attempts." });
  const unavailable = await start();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "Unavailable." });
});

test("native Google sign-in relays only the return address to the private attempt", async (t) => {
  const handled = [];
  const routes = createCloudRoutes({
    // A native-only host: no browser sign-in, so no Cloud web origin.
    browserSignIn: false,
    hostPolicy: {
      ...policy,
      createNativeCloudAuth: () => ({
        handle: async (operation, input) => {
          handled.push([operation, input]);
          return { status: "ok" };
        },
        cancel: async () => ({ status: "cancelled" }),
      }),
    },
    pendingCredentialStore: { read: async () => null },
    speechVoice: { voiceId: "voice", modelId: "model" },
    fetchImpl: async () => {
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
  const post = (path, value) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  const callbackUrl = "http://127.0.0.1:9/return#code=c&state=s";
  assert.equal(
    (await post("/cloud/native/start", { method: "google" })).status,
    200,
  );
  assert.equal(
    (await post("/cloud/native/google/return", { callbackUrl })).status,
    200,
  );
  for (const value of [
    { callbackUrl, sessionId: "x" },
    { callbackUrl, code: "c" },
  ])
    assert.equal(
      (await post("/cloud/native/google/return", value)).status,
      400,
    );
  // Only the route form is served; the operation name is not a path.
  assert.notEqual(
    (await post("/cloud/native/google-return", { callbackUrl })).status,
    200,
  );
  assert.deepEqual(handled, [
    ["start", { method: "google" }],
    ["google-return", { callbackUrl }],
  ]);
  assert.equal((await post("/cloud/login", {})).status, 404);
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${server.address().port}/cloud/login/status?sessionId=12345678-1234-1234-1234-123456789012`,
      )
    ).status,
    404,
  );
});

test("a host-only sign-in refuses browser, Google link and generic Google routes before any work", async (t) => {
  const handled = [],
    requests = [];
  const enrollment = {
    handle: async (operation, input) => {
      handled.push([operation, input]);
      return { status: "ok" };
    },
    cancel: async () => ({ status: "cancelled" }),
  };
  const routes = createCloudRoutes({
    browserSignIn: false,
    accountGoogleLink: false,
    googleSignInRoutes: false,
    hostPolicy: {
      ...policy,
      messages: {
        browserSignInUnavailable: "Sign in with a code in the app.",
        accountGoogleLinkUnavailable: "Sign in with a code in the app.",
        googleSignInRoutesUnavailable: "Choose Continue with Google.",
      },
      createNativeCloudAuth: () => enrollment,
    },
    pendingCredentialStore: { read: async () => null },
    speechVoice: { voiceId: "voice", modelId: "model" },
    fetchImpl: async (url) => {
      requests.push(url);
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
  const post = (path, value) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  const code = "Sign in with a code in the app.",
    google = "Choose Continue with Google.";
  const callbackUrl = "https://app.example/return#code=c&state=s";
  for (const [response, error] of [
    [await post("/cloud/login", {}), code],
    [
      await fetch(
        `${base}/cloud/login/status?sessionId=12345678-1234-1234-1234-123456789012`,
      ),
      code,
    ],
    [await post("/cloud/account/methods/google/start", {}), code],
    [await post("/cloud/account/methods/google/return", { callbackUrl }), code],
    [await post("/cloud/account/methods/google/status", {}), code],
    [await post("/cloud/account/methods/google/complete", {}), code],
    [await post("/cloud/account/methods/google/cancel", {}), code],
    [await post("/cloud/native/start", { method: "google" }), google],
    [await post("/cloud/native/google/return", { callbackUrl }), google],
  ]) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error,
      code: "internal_sign_in_only",
    });
  }
  assert.deepEqual(handled, []);
  assert.deepEqual(requests, []);
  // Code sign-in and the other account methods are still served.
  assert.equal(
    (await post("/cloud/native/start", { email: "a@example.test" })).status,
    200,
  );
  assert.equal((await post("/cloud/account/methods", {})).status, 200);
  assert.deepEqual(handled, [
    ["start", { email: "a@example.test" }],
    ["account-methods", {}],
  ]);
});

test("a service-only host composes CLI login and provider-default voice without billing routes", async (t) => {
  const calls = [];
  let cloudSaysCreated;
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
      if (
        url.endsWith(
          "/api/auth/cli-session/12345678-1234-1234-1234-123456789012",
        )
      )
        return Response.json({
          status: "authenticated",
          apiKey: "synthetic-cli-credential",
          ...(cloudSaysCreated === undefined
            ? {}
            : { accountCreated: cloudSaysCreated }),
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
  const beforeLanguageOverride = calls.length;
  assert.equal(
    (
      await post("/voice/stt", {
        audioBase64: "AQID",
        mimeType: "audio/wav",
        languageCode: "es",
      })
    ).status,
    400,
  );
  assert.equal(calls.length, beforeLanguageOverride);

  assert.equal((await post("/cloud/login", {})).status, 200);
  // The login reply says whether Cloud made the account, and says it again on a
  // repeated check; an older Cloud sends no flag, and the reply has no `created`.
  const status = async () =>
    (
      await fetch(
        `${base}/cloud/login/status?sessionId=12345678-1234-1234-1234-123456789012`,
      )
    ).json();
  for (const [said, reply] of [
    [true, { status: "authenticated", connected: true, created: true }],
    [false, { status: "authenticated", connected: true, created: false }],
    [undefined, { status: "authenticated", connected: true }],
  ]) {
    cloudSaysCreated = said;
    assert.equal((await post("/cloud/login", {})).status, 200);
    assert.deepEqual(await status(), reply);
    assert.deepEqual(await status(), reply);
  }
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

test("a host revocation port records a refused stored key before it is cleared", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-revocation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileCredentialStore(join(directory, "credential"));
  const ledger = { revoked: false, localDataPending: false, seen: [] };
  let failRecord = false;
  const users = new Set(["key-a"]),
    requests = [];
  let refuseLimits = false,
    holdUser = null,
    userAsked = () => {};
  const routes = createCloudRoutes({
    hostPolicy: policy,
    credentialStore: store,
    speechVoice: { voiceId: "voice", modelId: "model" },
    credentialRevocation: {
      onRevoked: async ({ key }) => {
        // Inside the critical section: the refused key is still stored.
        ledger.seen.push([key, await store.read()]);
        if (failRecord) throw Error("Ledger unavailable");
        Object.assign(ledger, { revoked: true, localDataPending: true });
      },
      status: () => ledger,
    },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname,
        key = init.headers.Authorization?.slice("Bearer ".length);
      requests.push(path);
      if (path === "/api/v1/user") {
        userAsked();
        await holdUser;
        return users.has(key)
          ? Response.json({ id: "user" })
          : Response.json({}, { status: 401 });
      }
      if (path === "/api/v1/billing/limits")
        return Response.json({}, { status: refuseLimits ? 401 : 200 });
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
  const access = async () =>
    (await fetch(`${base}/cloud/account/access`)).json();
  await store.write("key-a");
  assert.deepEqual(await access(), { state: "active" });
  // A billing refusal clears the key, as before, but names no revocation.
  refuseLimits = true;
  assert.deepEqual(await access(), { state: "signed_out" });
  assert.equal(await store.read(), null);
  refuseLimits = false;
  // A check that her own sign-out overtakes is not a revocation.
  await store.write("key-a");
  users.clear();
  let release;
  holdUser = new Promise((resolve) => {
    release = resolve;
  });
  const asking = new Promise((resolve) => {
    userAsked = resolve;
  });
  const overtaken = fetch(`${base}/cloud/account/access`);
  await asking;
  userAsked = () => {};
  const logout = await fetch(`${base}/cloud/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  release();
  holdUser = null;
  assert.equal((await overtaken).status, 409);
  assert.deepEqual(ledger.seen, []);
  // Signed out elsewhere: the host records it while the key is still stored.
  await store.write("key-a");
  failRecord = true;
  assert.deepEqual(await access(), { state: "unavailable" });
  assert.equal(await store.read(), "key-a", "Unrecorded: the key stays");
  failRecord = false;
  const revoked = {
    state: "signed_out",
    revoked: true,
    localDataPending: true,
  };
  assert.deepEqual(await access(), revoked);
  assert.deepEqual(ledger.seen, [
    ["key-a", "key-a"],
    ["key-a", "key-a"],
  ]);
  assert.equal(await store.read(), null);
  // Later answers still say why, without asking Cloud again.
  const asked = requests.length;
  assert.deepEqual(await access(), revoked);
  assert.equal(requests.length, asked);
});

test("concurrent account checks share one parallel Cloud read until an account change", async () => {
  const requests = [];
  let release = () => {},
    refuse = false,
    revoked = 0;
  const routes = createCloudRoutes({
    hostPolicy: policy,
    initialApiKey: "private-test-credential",
    speechVoice: { voiceId: "voice", modelId: "model" },
    credentialRevocation: {
      onRevoked: async () => {
        revoked++;
      },
      status: async () => ({ revoked: revoked > 0, localDataPending: false }),
    },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path === "/api/v1/user") {
        await new Promise((resolve) => {
          release = resolve;
        });
        return Response.json(refuse ? {} : { id: "user" }, {
          status: refuse ? 401 : 200,
        });
      }
      return Response.json({}, { status: refuse ? 401 : 200 });
    },
  });
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  };
  const first = routes.accountAccess();
  const joined = routes.requirePaidAccess();
  await settle();
  // Both reads are asked before the identity answer arrives.
  assert.deepEqual(requests, ["/api/v1/user", "/api/v1/billing/limits"]);
  // A state-changing route ends: a later check does not join the old read.
  const route = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  route.listen(0, "127.0.0.1");
  await once(route, "listening");
  try {
    const changed = await fetch(
      `http://127.0.0.1:${route.address().port}/cloud/not-a-route`,
      { method: "POST" },
    );
    assert.equal(changed.status, 404);
  } finally {
    route.closeAllConnections();
    await new Promise((resolve) => route.close(resolve));
  }
  const releaseFirst = release;
  const after = routes.accountAccess();
  await settle();
  assert.equal(requests.length, 4);
  releaseFirst();
  release();
  assert.deepEqual(await first, { state: "active" });
  await joined;
  assert.deepEqual(await after, { state: "active" });
  // A check that starts after the shared read settled asks Cloud again.
  const asked = requests.length;
  const later = routes.accountAccess();
  await settle();
  release();
  assert.deepEqual(await later, { state: "active" });
  assert.equal(requests.length, asked + 2);
  // The billing refusal arrives first; the identity refusal still names the
  // stored key as revoked.
  refuse = true;
  const refused = routes.accountAccess();
  await settle();
  release();
  assert.deepEqual(await refused, {
    state: "signed_out",
    revoked: true,
    localDataPending: false,
  });
  assert.equal(revoked, 1);
});

for (const responseStage of ["headers", "body"]) {
  test(`a stalled shared account ${responseStage} times out without revoking the key and a later check recovers`, async (t) => {
    const deadline = new AbortController();
    const realTimeout = AbortSignal.timeout;
    let deadlines = 0;
    t.mock.method(AbortSignal, "timeout", (milliseconds) => {
      assert.equal(milliseconds, 20_000);
      return ++deadlines === 1 ? deadline.signal : realTimeout(milliseconds);
    });
    let identityRequests = 0;
    let held;
    const bodyStarted = Promise.withResolvers();
    const provider = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/v1/user" && ++identityRequests === 1) {
        held = res;
        if (responseStage === "body") res.write("{");
        bodyStarted.resolve();
        return;
      }
      res.end("{}");
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    t.after(async () => {
      held?.end("}");
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
    });
    let revoked = 0;
    const routes = createCloudRoutes({
      hostPolicy: policy,
      initialApiKey: "private-test-credential",
      speechVoice: { voiceId: "voice", modelId: "model" },
      credentialRevocation: {
        onRevoked: async () => {
          revoked++;
        },
        status: async () => ({ revoked: false, localDataPending: false }),
      },
      fetchImpl: (url, init) =>
        fetch(
          `http://127.0.0.1:${provider.address().port}${new URL(url).pathname}`,
          init,
        ),
    });
    const first = routes.accountAccess();
    const joined = routes.accountAccess();
    await bodyStarted.promise;
    deadline.abort(new DOMException("Account access deadline", "TimeoutError"));
    const outcomes = await Promise.race([
      Promise.all([first, joined]),
      new Promise((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
    assert.deepEqual(outcomes, [
      { state: "unavailable" },
      { state: "unavailable" },
    ]);
    assert.equal(revoked, 0);
    assert.deepEqual(await routes.accountAccess(), { state: "active" });
    assert.equal(identityRequests, 2);
    assert.equal(deadlines, 2);
  });
}

test("a check after a sign-in's credential write never joins an older read", async (t) => {
  const session = "12345678-1234-1234-1234-123456789012";
  const requests = [];
  let holdStatus = null;
  const routes = createCloudRoutes({
    hostPolicy: policy,
    speechVoice: { voiceId: "voice", modelId: "model" },
    credentialRevocation: {
      onRevoked: async () => {},
      status: async () => {
        await holdStatus?.promise;
        return { revoked: false, localDataPending: false };
      },
    },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path === "/api/auth/cli-session")
        return Response.json({ sessionId: session });
      if (path === `/api/auth/cli-session/${session}`)
        return Response.json({
          status: "authenticated",
          apiKey: "synthetic-cli-credential",
        });
      if (path === "/api/v1/user") return Response.json({ id: "user" });
      return Response.json({});
    },
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    holdStatus?.resolve();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/cloud/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(login.status, 200);
  // A signed-out read is in flight when the sign-in finishes.
  holdStatus = Promise.withResolvers();
  const before = routes.accountAccess();
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  // The sign-in poll is a GET, so only the credential write marks the change.
  const polled = await fetch(`${base}/cloud/login/status?sessionId=${session}`);
  assert.equal((await polled.json()).status, "authenticated");
  const asked = requests.length;
  const after = routes.accountAccess();
  holdStatus.resolve();
  assert.deepEqual(await before, { state: "signed_out" });
  assert.deepEqual(await after, { state: "active" });
  assert.deepEqual(requests.slice(asked), [
    "/api/v1/user",
    "/api/v1/billing/limits",
  ]);
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

// A loopback stand-in for Cloud's redeem and account routes. `answer` decides
// each redeem reply; it may destroy the socket to lose the answer in transit.
async function subscriptionCloud(t, answer) {
  const redeems = [];
  const cloud = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reply = (status, value, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(typeof value === "string" ? value : JSON.stringify(value));
    };
    if (req.url === "/api/v1/user") return reply(200, { data: { id: "user" } });
    if (req.url === "/api/v1/billing/limits")
      return reply(200, {
        data: {
          v2: {
            snapshotCompletedAt: new Date().toISOString(),
            grant: {
              status: "available",
              value: {
                grantId: "grant-1",
                planKey: "annual_team",
                startsAt: "2026-01-01T00:00:00.000Z",
                endsAt: "2099-01-01T00:00:00.000Z",
                paidPlanTakesPrecedence: false,
                allowance: { status: "unavailable" },
              },
            },
          },
        },
      });
    if (req.method === "POST" && req.url === "/api/v1/subscription/redeem") {
      redeems.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      return answer({ req, res, reply, attempt: redeems.length });
    }
    reply(404, { error: "not found" });
  });
  cloud.listen(0, "127.0.0.1");
  await once(cloud, "listening");
  t.after(() => {
    cloud.closeAllConnections();
    cloud.close();
  });
  const local = `http://127.0.0.1:${cloud.address().port}`;
  return {
    redeems,
    fetchImpl: (url, init) =>
      fetch(url.replace("https://api.eliza.app", local), init),
  };
}
async function serve(t, routes) {
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
  return (value, path = "/cloud/account/subscription/redeem") =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
}
const redeemed = (grant = {}, replayed = false) => ({
  success: true,
  replayed,
  grant: {
    id: "grant-1",
    planKey: "annual_team",
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2099-01-01T00:00:00.000Z",
    revoked: false,
    paidPlanTakesPrecedence: false,
    ...grant,
  },
});

test("subscription code redemption and the snapshot grant stay off unless the host opts in", async (t) => {
  const seen = [];
  const cloud = await subscriptionCloud(t, ({ reply }) =>
    reply(200, redeemed()),
  );
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      projectAccountAccess: (...args) => {
        seen.push(args.length);
        return { state: "active" };
      },
    },
    speechVoice: { voiceId: "voice", modelId: "model" },
    initialApiKey: "private-test-credential",
    fetchImpl: cloud.fetchImpl,
  });
  const post = await serve(t, routes);
  assert.equal((await post({ code: "ABCD-EFGH-JKMN-PQRS" })).status, 404);
  assert.equal(cloud.redeems.length, 0);
  await routes.accountAccess();
  assert.deepEqual(seen, [2]);
});

test("a host that opts in redeems a code once, replays a lost answer and reads the grant", async (t) => {
  let pending = null,
    answer = ({ res, attempt }) =>
      attempt === 1
        ? res.destroy()
        : res.writeHead(200).end(JSON.stringify(redeemed()));
  const cloud = await subscriptionCloud(t, (input) => answer(input));
  const projected = [];
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      subscriptionCodes: true,
      messages: {
        subscriptionCodeInvalid: "Host words: invalid",
        subscriptionCodePaidPlanActive: "Host words: paid plan",
        subscriptionCodeEnded: "Host words: ended",
        subscriptionCodeSignedOut: "Host words: signed out",
      },
      projectAccountAccess: (_user, _snapshot, context) => {
        projected.push(context);
        return { state: "active" };
      },
    },
    pendingCredentialStore: { read: async () => pending },
    speechVoice: { voiceId: "voice", modelId: "model" },
    initialApiKey: "private-test-credential",
    fetchImpl: cloud.fetchImpl,
  });
  const post = await serve(t, routes);

  // The first answer is lost; one replay with the same key gets the grant.
  const first = await post({ code: " abcd efgh jkmn pqrs " });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    replayed: false,
    grant: {
      planKey: "annual_team",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z",
      paidPlanTakesPrecedence: false,
    },
  });
  assert.equal(cloud.redeems.length, 2);
  assert.deepEqual(cloud.redeems[0], cloud.redeems[1]);
  assert.equal(
    cloud.redeems[0].authorization,
    "Bearer private-test-credential",
  );
  assert.equal(cloud.redeems[0].body.code, "ABCDEFGHJKMNPQRS");
  assert.match(cloud.redeems[0].body.idempotencyKey, /^redeem:[0-9a-f]{40}$/);

  // Cloud's refusals become typed codes with the host's words, never Cloud's.
  for (const [reply, status, code, error] of [
    [
      [400, { code: "invalid_subscription_code", error: "Cloud words" }],
      400,
      "invalid",
      "Host words: invalid",
    ],
    [
      [409, { code: "subscription_grant_paid_plan_active" }],
      409,
      "paid-plan-active",
      "Host words: paid plan",
    ],
    [
      [409, { code: "subscription_grant_already_redeemed" }],
      409,
      "already-redeemed",
    ],
    [[403, { code: "access_denied" }], 403, "account"],
    [[500, { code: "internal_error" }], 503, "unavailable"],
    [
      [200, redeemed({ revoked: true }, true)],
      409,
      "ended",
      "Host words: ended",
    ],
    [
      [200, redeemed({ endsAt: "2026-02-01T00:00:00.000Z" }, true)],
      409,
      "ended",
    ],
    [[200, redeemed({ planKey: "plus_monthly" })], 503, "unavailable"],
    [[200, "x".repeat(70000)], 503, "unavailable"],
  ]) {
    answer = ({ reply: send }) => send(...reply);
    const response = await post({ code: "ABCDEFGHJKMNPQRS" });
    const value = await response.json();
    assert.deepEqual([response.status, value.code], [status, code], code);
    if (error) assert.equal(value.error, error);
    assert.doesNotMatch(JSON.stringify(value), /Cloud words|ABCD/);
  }
  answer = ({ reply }) =>
    reply(429, { code: "rate_limited" }, { "Retry-After": "90" });
  const limited = await post({ code: "ABCDEFGHJKMNPQRS" });
  assert.deepEqual(
    [limited.status, (await limited.json()).retryAfter],
    [429, 90],
  );

  // A body that cannot be a code, or a pending disconnect, never reaches Cloud.
  const before = cloud.redeems.length;
  for (const value of [
    { code: "short" },
    { code: "ABCDEFGHJKMNPQRS", plan: "x" },
    "x".repeat(5000),
  ]) {
    const response = await post(value);
    assert.deepEqual(
      [response.status, (await response.json()).code],
      [400, "invalid"],
    );
  }
  pending = JSON.stringify({ kind: "revocation" });
  const signedOut = await post({ code: "ABCDEFGHJKMNPQRS" });
  assert.deepEqual(
    [signedOut.status, await signedOut.json()],
    [401, { error: "Host words: signed out", code: "signed-out" }],
  );
  assert.equal(cloud.redeems.length, before);
  pending = null;

  // The account check gives the host the snapshot's grant.
  await routes.accountAccess();
  assert.deepEqual(projected.at(-1), {
    grant: {
      status: "active",
      planKey: "annual_team",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z",
      paidPlanTakesPrecedence: false,
      allowance: null,
    },
  });
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

const GRANT_A = "11111111-1111-4111-8111-111111111111";
const GRANT_B = "22222222-2222-4222-8222-222222222222";
const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
function googleHost(t, google, extraPolicy = {}) {
  const calls = [];
  const routes = createCloudRoutes({
    hostPolicy: {
      ...extraPolicy,
      accountBilling: false,
      providerDefaultVoice: true,
      speechLanguage: null,
      multipartPrefix: "independent-host",
      requireNonSensitiveText(text) {
        if (google.policyFailure) throw new Error("private policy failure");
        if (/\d{6}/.test(text))
          throw Object.assign(new Error("sensitive"), {
            code: "SENSITIVE_TEXT",
          });
      },
      pickMessage: (value) => ({ id: value.externalId }),
    },
    initialApiKey: "synthetic-credential",
    credentialGate: async () => "owner",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/api/v1/voice/stt")
        return Response.json({ text: google.transcript ?? "hello" });
      if (path === "/api/v1/eliza/google/status") {
        if (
          google.afterDispatchStatus &&
          calls.some((call) => call.url.endsWith("/dispatch"))
        )
          return google.afterDispatchStatus();
        // Cloud answers for a named connection when grantId is given.
        const named = new URL(url).searchParams.get("grantId");
        if (named && google.connections)
          return Response.json({
            connected: Boolean(google.connections[named]),
            configured: true,
            reason: google.connections[named] ? "connected" : "disconnected",
            identity: { email: "owner@example.test" },
            connectionId: google.connections[named]
              ? (google.answerAs ?? named)
              : null,
            grantedCapabilities: ["google.gmail.triage"],
            grantedScopes: google.connections[named] ?? [],
          });
        return Response.json({
          connected: google.connectionId !== null && !google.reason,
          configured: true,
          reason:
            google.reason ??
            (google.connectionId ? "connected" : "disconnected"),
          identity: { email: "owner@example.test" },
          connectionId: google.connectionId,
          grantedCapabilities: ["google.gmail.triage"],
          grantedScopes: google.scopes ?? [READ_SCOPE, "openid"],
        });
      }
      if (path === "/api/v1/eliza/google/accounts")
        return Response.json(
          (google.accounts ?? []).map((connectionId) => ({ connectionId })),
        );
      if (path === "/api/v1/eliza/google/disconnect") {
        const { connectionId } = JSON.parse(init.body);
        if (google.accounts && connectionId) {
          google.accounts = google.accounts.filter((id) => id !== connectionId);
          return Response.json({ ok: true });
        }
        google.connectionId = null;
        return Response.json({ ok: true });
      }
      if (path === "/api/v1/eliza/google/connect/initiate")
        return Response.json({
          authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=x",
        });
      if (path === "/api/v1/eliza/google/gmail/inbox-v1/capabilities")
        return google.capabilitiesStatus
          ? new Response(null, { status: google.capabilitiesStatus })
          : Response.json(
              google.capabilities ?? {
                version: 1,
                attachmentPolicy: {
                  mimeTypes: ["application/pdf", "image/png"],
                  maximumBytes: 5242880,
                  maximumOutgoing: 10,
                  maximumTotalBytes: 5242880,
                },
              },
            );
      if (path.startsWith("/api/v1/eliza/google/gmail/inbox-v1/operations")) {
        if (google.operationResponse) return google.operationResponse(path);
        if (google.operationStatus)
          return new Response(null, { status: google.operationStatus });
        const body = init.body ? JSON.parse(init.body) : null;
        const requestId = body?.requestId ?? path.split("/").filter(Boolean)[7];
        const kind = (body?.proposal ?? google.lastProposal)?.kind;
        if (body?.proposal) google.lastProposal = body.proposal;
        return Response.json({
          version: 1,
          receipt: {
            requestId,
            kind,
            reviewDigest: "a".repeat(64),
            state: path.endsWith("/dispatch") ? "succeeded" : "prepared",
            providerResult: path.endsWith("/dispatch")
              ? { messageId: "m1", labelIds: ["UNREAD"], historyId: "4243" }
              : null,
            rejectionCode: null,
            createdAt: "2026-10-30T00:00:00Z",
          },
          ...(body?.requestId ? { review: { kind, messageId: "m1" } } : {}),
          providerExactlyOnce: false,
        });
      }
      if (path === "/api/v1/eliza/google/gmail/search") {
        if (google.searchFailures?.length) {
          const status = google.searchFailures.shift();
          google.afterFailure?.();
          return new Response(null, { status });
        }
        await google.beforeSearch?.();
        return Response.json({ messages: [], nextPageToken: null });
      }
      throw Error("Unexpected provider request");
    },
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const post = async (route, value) => {
    if (!server.listening) await once(server, "listening");
    return fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  };
  const get = async (route) => {
    if (!server.listening) await once(server, "listening");
    return fetch(`http://127.0.0.1:${server.address().port}${route}`);
  };
  return { routes, calls, post, get };
}
const search = (accountId) => ({
  accountId,
  query: "from:billing@example.test",
  pageSize: 10,
});

test("Gmail status names its connection and whether message bodies can be read", async (t) => {
  const google = { connectionId: GRANT_A };
  const { get, calls } = googleHost(t, google);
  const status = await (await get("/gmail/status")).json();
  assert.equal(status.connectionId, GRANT_A);
  assert.deepEqual(status.grantedScopes, [READ_SCOPE, "openid"]);
  assert.equal(status.canReadMessages, true);
  // A metadata-only grant still reports triage but cannot read messages.
  google.scopes = [METADATA_SCOPE, "not a scope"];
  const metadata = await (await get("/gmail/status")).json();
  assert.deepEqual(metadata.grantedCapabilities, ["google.gmail.triage"]);
  assert.deepEqual(metadata.grantedScopes, [METADATA_SCOPE]);
  assert.equal(metadata.canReadMessages, false);
  // Only an exactly read-only grant reads messages. A wider grant is reported
  // with its scopes, and cannot read.
  for (const wider of [
    [READ_SCOPE, "https://www.googleapis.com/auth/gmail.modify"],
    [READ_SCOPE, "https://www.googleapis.com/auth/gmail.send"],
    [READ_SCOPE, "https://mail.google.com/"],
    ["https://www.googleapis.com/auth/gmail.modify"],
    [READ_SCOPE, "https://www.googleapis.com/auth/cloud-platform"],
  ]) {
    google.scopes = wider;
    const status = await (await get("/gmail/status")).json();
    assert.equal(status.canReadMessages, false, wider.join(" "));
    // A scope the host cannot name is left out of the report, yet still makes the grant wider.
    assert.deepEqual(
      status.grantedScopes,
      wider.filter((scope) => !scope.includes("cloud-platform")),
    );
  }
  google.scopes = [
    READ_SCOPE,
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ];
  assert.equal(
    (await (await get("/gmail/status")).json()).canReadMessages,
    true,
  );
  google.scopes = undefined;
  google.connectionId = null;
  const disconnected = await (await get("/gmail/status")).json();
  assert.equal(disconnected.connectionId, null);
  assert.equal(disconnected.canReadMessages, false);
  assert.equal(calls.length, 9);
});

test("Gmail status reports the host policy and its verdict on each grant", async (t) => {
  const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
  const SEND = "https://www.googleapis.com/auth/gmail.send";
  // [scopes, verdict on a read-only host, verdict on an owner-writes host]
  for (const [scopes, readOnlyHost, writesHost] of [
    [[READ_SCOPE, "openid"], "read-only", "read-only"],
    [[READ_SCOPE, MODIFY, "email"], "too-broad", "part-write"],
    [[READ_SCOPE, SEND], "too-broad", "part-write"],
    [[READ_SCOPE, MODIFY, SEND, "openid"], "too-broad", "write"],
    [[READ_SCOPE, "https://mail.google.com/"], "too-broad", "too-broad"],
    [[READ_SCOPE, METADATA_SCOPE], "too-broad", "too-broad"],
    [[READ_SCOPE, "not a scope"], "too-broad", "too-broad"],
    [[METADATA_SCOPE, "openid"], "no-read", "no-read"],
    [["openid", "email"], "no-read", "no-read"],
    [[MODIFY, SEND], "too-broad", "no-read"],
  ]) {
    for (const [ownerWrites, grant] of [
      [false, readOnlyHost],
      [true, writesHost],
    ]) {
      const google = { connectionId: GRANT_A, scopes };
      const { get } = googleHost(t, google, { gmailOwnerWrites: ownerWrites });
      const status = await (await get("/gmail/status")).json();
      const label = `${scopes.join(" ")} ownerWrites=${ownerWrites}`;
      assert.equal(status.ownerWrites, ownerWrites, label);
      assert.equal(status.grant, grant, label);
      assert.equal(
        status.canReadMessages,
        ["read-only", "part-write", "write"].includes(grant),
        label,
      );
      // Not connected: the policy is still reported, and nothing reads.
      google.connectionId = null;
      const disconnected = await (await get("/gmail/status")).json();
      assert.deepEqual(
        [disconnected.ownerWrites, disconnected.grant],
        [ownerWrites, "no-read"],
        label,
      );
    }
  }
});

test("a Gmail grant wider than read-only is never read, by task reads or by list and read", async (t) => {
  const google = {
    connectionId: GRANT_A,
    scopes: [READ_SCOPE, "https://www.googleapis.com/auth/gmail.modify"],
  };
  const { routes, calls, post } = googleHost(t, google);
  const port = routes.googleForAccount({ actorId: "owner", retryDelaysMs: [] });
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "insufficient_scope",
    status: 403,
  });
  await assert.rejects(port.currentAccount(), { code: "insufficient_scope" });
  assert.equal(
    (await post("/gmail/list", { query: "bill", grantId: GRANT_A })).status,
    403,
  );
  assert.equal(
    (await post("/gmail/read", { messageId: "m1", grantId: GRANT_A })).status,
    403,
  );
  assert.equal(
    calls.filter((c) => /\/gmail\/(search|read)/.test(new URL(c.url).pathname))
      .length,
    0,
    "No message was searched or read",
  );
  // The same connection, once it is exactly read-only, is read as before.
  google.scopes = [READ_SCOPE, "openid"];
  await port.searchGmailMessagesPage(search(GRANT_A));
  assert.equal(
    (await post("/gmail/list", { query: "bill", grantId: GRANT_A })).status,
    200,
  );
});

test("Gmail list and read check the named connection, not the default one", async (t) => {
  // A is the default and read-only; B was widened by another client.
  const google = {
    connectionId: GRANT_A,
    scopes: [READ_SCOPE, "openid"],
    connections: {
      [GRANT_A]: [READ_SCOPE, "openid"],
      [GRANT_B]: [READ_SCOPE, "https://www.googleapis.com/auth/gmail.modify"],
    },
  };
  const { calls, post } = googleHost(t, google);
  const readsOfMail = () =>
    calls.filter((c) => /\/gmail\/(search|read)/.test(new URL(c.url).pathname))
      .length;
  assert.equal(
    (await post("/gmail/list", { query: "bill", grantId: GRANT_B })).status,
    403,
  );
  assert.equal(
    (await post("/gmail/read", { messageId: "m1", grantId: GRANT_B })).status,
    403,
  );
  assert.equal(readsOfMail(), 0, "No message was searched or read through B");
  const statusChecks = calls.filter(
    (c) => new URL(c.url).pathname === "/api/v1/eliza/google/status",
  );
  assert.ok(statusChecks.length >= 2);
  for (const c of statusChecks)
    assert.equal(new URL(c.url).searchParams.get("grantId"), GRANT_B);
  // A named connection Cloud answers for under another id is refused.
  google.connections[GRANT_B] = [READ_SCOPE, "openid"];
  google.answerAs = GRANT_A;
  assert.equal(
    (await post("/gmail/list", { query: "bill", grantId: GRANT_B })).status,
    409,
  );
  assert.equal(readsOfMail(), 0);
  google.answerAs = undefined;
  // The inverse: a wider default does not block a read-only B named explicitly.
  google.scopes = [READ_SCOPE, "https://www.googleapis.com/auth/gmail.modify"];
  assert.equal(
    (await post("/gmail/list", { query: "bill", grantId: GRANT_B })).status,
    200,
  );
  assert.equal(readsOfMail(), 1);
});

test("Gmail list and read name the shown connection; a bad grant is refused", async (t) => {
  const google = { connectionId: GRANT_A };
  const { post, calls } = googleHost(t, google);
  assert.equal(
    (await post("/gmail/list", { query: "bill", grantId: "../other" })).status,
    400,
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (await post("/gmail/list", { query: "bill", grantId: GRANT_A })).status,
    200,
  );
  const listed = new URL(calls.at(-1).url);
  assert.equal(listed.pathname, "/api/v1/eliza/google/gmail/search");
  assert.equal(listed.searchParams.get("grantId"), GRANT_A);
});

test("Gmail disconnect proxies the owner connection and fences an in-flight task read", async (t) => {
  let release;
  const google = {
    connectionId: GRANT_A,
    beforeSearch: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const { routes, post, calls } = googleHost(t, google);
  const port = routes.googleForAccount({
    actorId: "owner",
    retryDelaysMs: [],
  });
  assert.equal(await port.currentAccountId(), GRANT_A);
  const read = port.searchGmailMessagesPage(search(GRANT_A));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await post("/gmail/disconnect", { connectionId: "bad id" })).status,
    400,
  );
  const response = await post("/gmail/disconnect", { connectionId: GRANT_A });
  assert.deepEqual(await response.json(), { disconnected: true });
  const sent = calls.find((c) => c.url.endsWith("/google/disconnect"));
  assert.deepEqual(JSON.parse(sent.init.body), {
    side: "owner",
    connectionId: GRANT_A,
  });
  release();
  await assert.rejects(read, { code: "account_changed", status: 409 });
  // After the disconnect, a new read finds no connected account.
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "account_changed",
  });
});

test("a task read bound to one Google connection refuses another connected mailbox", async (t) => {
  const google = { connectionId: GRANT_A };
  const { routes, calls } = googleHost(t, google);
  const port = routes.googleForAccount({ actorId: "owner", retryDelaysMs: [] });
  const bound = await port.currentAccountId();
  assert.deepEqual(await port.searchGmailMessagesPage(search(bound)), {
    messages: [],
    nextPageToken: null,
  });
  const searched = calls.find((c) => c.url.includes("/gmail/search"));
  assert.equal(new URL(searched.url).searchParams.get("grantId"), GRANT_A);
  // Margaret reconnects with another account. The task's grant is now stale.
  google.connectionId = GRANT_B;
  const before = calls.length;
  await assert.rejects(port.searchGmailMessagesPage(search(bound)), {
    code: "account_changed",
  });
  assert.equal(
    calls.slice(before).some((c) => c.url.includes("/gmail/search")),
    false,
  );
  // A fixed configured grant is held to the same check.
  const fixed = routes.googleForAccount({
    actorId: "owner",
    accountId: GRANT_A,
    retryDelaysMs: [],
  });
  await assert.rejects(fixed.searchGmailMessagesPage(search(GRANT_A)), {
    code: "account_changed",
  });
});

test("task reads report typed reasons and retry only transient failures", async (t) => {
  const google = { connectionId: GRANT_A, scopes: [METADATA_SCOPE] };
  const { routes, calls } = googleHost(t, google);
  const port = routes.googleForAccount({
    actorId: "owner",
    retryDelaysMs: [1, 1],
  });
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "insufficient_scope",
    status: 403,
  });
  google.scopes = undefined;
  google.searchFailures = [503, 429];
  const before = calls.length;
  await port.searchGmailMessagesPage(search(GRANT_A));
  assert.equal(
    calls.slice(before).filter((c) => c.url.includes("/gmail/search")).length,
    3,
  );
  google.searchFailures = [503, 503, 503];
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "unavailable",
  });
  // Cloud's 401 or 403 rejects the Eliza Cloud sign-in, not the Google
  // connection, so it is never reported as a Gmail reconnect.
  for (const status of [401, 403]) {
    google.searchFailures = [status];
    await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
      code: "cloud_sign_in_required",
    });
  }
  // Cloud's Google connector answers 409 when the Google token cannot be
  // refreshed. A fresh status check names the case: a token that needs a
  // reconnect, or an outage while the same grant is still connected.
  google.searchFailures = [409];
  google.afterFailure = () => {
    google.reason = "needs_reauth";
  };
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "reauth_required",
  });
  google.reason = undefined;
  google.searchFailures = [409];
  google.afterFailure = undefined;
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "unavailable",
  });
  google.searchFailures = [409];
  google.afterFailure = () => {
    google.scopes = [METADATA_SCOPE];
  };
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "insufficient_scope",
  });
  google.scopes = undefined;
  google.searchFailures = [409];
  google.afterFailure = () => {
    google.connectionId = GRANT_B;
  };
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "account_changed",
  });
  google.connectionId = GRANT_A;
  google.afterFailure = undefined;
  // The Google connection no longer exists.
  google.searchFailures = [404];
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "account_changed",
  });
  // A refusal is never retried.
  google.searchFailures = [400, 400];
  const refused = calls.length;
  await assert.rejects(port.searchGmailMessagesPage(search(GRANT_A)), {
    code: "unavailable",
  });
  assert.equal(
    calls.slice(refused).filter((c) => c.url.includes("/gmail/search")).length,
    1,
  );
});

test("a heard secret is withheld from the transcript and flagged", async (t) => {
  const google = { connectionId: GRANT_A, transcript: "my code is 123456" };
  const { post } = googleHost(t, google);
  const audio = { audioBase64: "AQID", mimeType: "audio/wav" };
  assert.deepEqual(await (await post("/voice/stt", audio)).json(), {
    text: "",
    redacted: true,
  });
  google.policyFailure = true;
  const failed = await post("/voice/stt", audio);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "Cloud service unavailable" });
  google.policyFailure = false;
  google.transcript = "call my daughter";
  assert.deepEqual(await (await post("/voice/stt", audio)).json(), {
    text: "call my daughter",
  });
});

test("native auth learns whether Google account linking is ready, off by default", () => {
  for (const [accountLinkReady, expected] of [
    [undefined, false],
    ["yes", false],
    [true, true],
  ]) {
    let options;
    createCloudRoutes({
      hostPolicy: {
        ...policy,
        accountLinkReady,
        createNativeCloudAuth: (value) => {
          options = value;
          return {};
        },
      },
      pendingCredentialStore: { read: async () => null },
      speechVoice: { voiceId: "voice", modelId: "model" },
      fetchImpl: async () => {
        throw Error("Unexpected provider request");
      },
    });
    assert.equal(options.accountLinkReady, expected);
  }
});

test("after a new Google grant, every other owner connection is removed", async (t) => {
  const google = { connectionId: GRANT_B, accounts: [GRANT_A, GRANT_B] };
  const { post, calls } = googleHost(t, google);
  // Only the connection Cloud reports as current can be kept.
  assert.equal(
    (await post("/cloud/gmail/disconnect-others", { connectionId: GRANT_A }))
      .status,
    409,
  );
  assert.equal(
    (await post("/cloud/gmail/disconnect-others", { connectionId: "bad id" }))
      .status,
    400,
  );
  assert.equal(
    calls.some((c) => c.url.endsWith("/google/disconnect")),
    false,
  );
  const response = await post("/cloud/gmail/disconnect-others", {
    connectionId: GRANT_B,
  });
  assert.deepEqual(await response.json(), { disconnected: 1 });
  const sent = calls.filter((c) => c.url.endsWith("/google/disconnect"));
  assert.deepEqual(
    sent.map((c) => JSON.parse(c.init.body)),
    [{ side: "owner", connectionId: GRANT_A }],
  );
  assert.deepEqual(google.accounts, [GRANT_B]);
});

test("a task port reports the connected Google address with its grant", async (t) => {
  const { routes } = googleHost(t, { connectionId: GRANT_A });
  const port = routes.googleForAccount({ actorId: "owner", retryDelaysMs: [] });
  assert.deepEqual(await port.currentAccount(), {
    accountId: GRANT_A,
    email: "owner@example.test",
  });
});

test("mailbox projection fences grant replacement while a read is in flight", async (t) => {
  let release;
  const google = {
    connectionId: GRANT_A,
    beforeSearch: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const { routes } = googleHost(t, google);
  const port = routes.mailboxForAccount({
    actorId: "owner",
    accountId: GRANT_A,
    retryDelaysMs: [],
  });
  const read = port.list({
    accountId: GRANT_A,
    query: "in:inbox",
    pageSize: 10,
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  google.connectionId = GRANT_B;
  release();
  await assert.rejects(read, { code: "account_changed", status: 409 });
});

test("mailbox projection rejects another grant and revoked connection before content access", async (t) => {
  const google = { connectionId: GRANT_A };
  const { routes, calls, post } = googleHost(t, google);
  const port = routes.mailboxForAccount({
    actorId: "owner",
    accountId: GRANT_A,
    retryDelaysMs: [],
  });
  await assert.rejects(
    port.list({
      accountId: GRANT_B,
      query: "in:inbox",
      pageSize: 10,
      pageToken: "from-another-grant",
    }),
    { status: 409 },
  );
  assert.ok(!calls.some((c) => c.url.includes("/gmail/search")));
  await post("/gmail/disconnect", { connectionId: GRANT_A });
  await assert.rejects(
    port.list({ accountId: GRANT_A, query: "in:inbox", pageSize: 10 }),
    { code: "account_changed" },
  );
});

test("optional verified native port uses whole-record CAS and refuses legacy activation", async (t) => {
  let raw = null,
    callbacks,
    failExchange = false,
    writes = 0;
  const record = {
    version: 1,
    credential: "synthetic-secret-only-for-tests",
    credentialId: "credential-1",
    owner: {
      authority: "https://api.example.test",
      userId: "user-1",
      organizationId: "org-1",
    },
  };
  const port = {
    read: async () => raw,
    compareExchange: async (expected, next) => {
      writes++;
      if (failExchange || expected !== raw) return false;
      raw = next;
      return true;
    },
  };
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      providerDefaultVoice: true,
      createNativeCloudAuth: (options) => {
        callbacks = options;
        return {
          cancel: async () => {
            await options.clearActive();
          },
          handle: async () => ({ status: "pending" }),
        };
      },
    },
    verifiedAccountStore: port,
    pendingCredentialStore: { read: async () => null },
    fetchImpl: async () => {
      throw Error("Legacy provider must not be called");
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
  const post = (path) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  await callbacks.activateVerified(record, () => {});
  assert.equal(await callbacks.readActive(), record.credential);
  let response = await post("/cloud/login");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "VERIFIED_ACCOUNT_REQUIRED");
  assert.equal(raw, JSON.stringify(record));
  await assert.rejects(
    callbacks.activate("unverified", () => {}),
    (e) => e.code === "VERIFIED_ACCOUNT_REQUIRED",
  );
  assert.equal(raw, JSON.stringify(record));
  response = await fetch(base + "/cloud/status");
  const status = await response.json();
  assert.equal(status.connected, true);
  assert.equal(status.credentialPersistence, "host-managed");
  assert.ok(!JSON.stringify(status).includes(record.credential));
  failExchange = true;
  await assert.rejects(
    callbacks.activateVerified(
      { ...record, credential: "replacement" },
      () => {},
    ),
    (e) => e.code === "VERIFIED_ACCOUNT_REQUIRED",
  );
  assert.equal(raw, JSON.stringify(record));
  failExchange = false;
  response = await post("/cloud/logout");
  assert.equal(response.status, 200);
  assert.equal(raw, null);
  const count = writes;
  await assert.rejects(
    callbacks.activateVerified(record, () => {
      throw Error("retired");
    }),
  );
  assert.equal(writes, count);
  for (const options of [
    { initialApiKey: "key" },
    { credentialStore: {} },
    { pendingCredentialStore: undefined },
  ])
    assert.throws(
      () =>
        createCloudRoutes({
          hostPolicy: { ...policy, providerDefaultVoice: true },
          verifiedAccountStore: port,
          pendingCredentialStore: { read: async () => null },
          ...options,
        }),
      /exclusive native/,
    );
});

test("verified pending revocation clears whole record; malformed native snapshot refuses", async () => {
  let raw = JSON.stringify({
    version: 1,
    credential: "synthetic-secret-only-for-tests",
    credentialId: "id",
    owner: {
      authority: "https://api.example.test",
      userId: "u",
      organizationId: "o",
    },
  });
  const port = {
    read: async () => raw,
    compareExchange: async (expected, next) => {
      assert.equal(expected, raw);
      raw = next;
      return true;
    },
  };
  const routes = createCloudRoutes({
    hostPolicy: { ...policy, providerDefaultVoice: true },
    verifiedAccountStore: port,
    pendingCredentialStore: {
      read: async () => JSON.stringify({ kind: "revocation" }),
    },
  });
  await routes.ready;
  assert.equal(raw, null);
  raw = "corrupt";
  const broken = createCloudRoutes({
    hostPolicy: { ...policy, providerDefaultVoice: true },
    verifiedAccountStore: port,
    pendingCredentialStore: {
      read: async () => JSON.stringify({ kind: "revocation" }),
    },
  });
  await assert.rejects(
    broken.ready,
    (e) => e.code === "VERIFIED_ACCOUNT_REQUIRED",
  );
  assert.equal(raw, "corrupt");
});

test("verified CAS preserves replacement on stale clear and refuses retired admission", async () => {
  const record = {
    version: 1,
    credential: "synthetic-secret-only-for-tests",
    credentialId: "id",
    owner: {
      authority: "https://api.example.test",
      userId: "u",
      organizationId: "o",
    },
  };
  let raw = JSON.stringify(record),
    callbacks,
    readHook = () => {},
    exchangeHook = () => {},
    exchanges = 0;
  const replacement = JSON.stringify({ ...record, credentialId: "new" });
  createCloudRoutes({
    hostPolicy: {
      ...policy,
      providerDefaultVoice: true,
      createNativeCloudAuth: (options) => {
        callbacks = options;
        return {};
      },
    },
    pendingCredentialStore: { read: async () => null },
    verifiedAccountStore: {
      read: async () => {
        const before = raw;
        readHook();
        return before;
      },
      compareExchange: async (expected, next) => {
        exchanges++;
        exchangeHook();
        if (expected !== raw) return false;
        raw = next;
        return true;
      },
    },
  });
  readHook = () => {
    raw = replacement;
  };
  await assert.rejects(
    callbacks.clearActive(),
    (e) => e.code === "VERIFIED_ACCOUNT_REQUIRED",
  );
  assert.equal(raw, replacement);
  let retired = false;
  const guard = () => {
    if (retired) throw Error("retired");
  };
  readHook = () => {
    retired = true;
  };
  const before = exchanges;
  await assert.rejects(callbacks.activateVerified(record, guard), /retired/);
  assert.equal(exchanges, before);
  assert.equal(raw, replacement);
  retired = false;
  readHook = () => {};
  exchangeHook = () => {
    retired = true;
  };
  await assert.rejects(callbacks.activateVerified(record, guard), /retired/);
  // A lost/retired acknowledgement does not imply rollback. Native guard owns mutation fencing.
  assert.equal(raw, JSON.stringify(record));
  for (const malformed of [
    { ...record, extra: true },
    { ...record, owner: { ...record.owner, extra: true } },
    {
      ...record,
      owner: { ...record.owner, authority: "https://api.example.test/path" },
    },
  ]) {
    raw = JSON.stringify(malformed);
    await assert.rejects(
      callbacks.readActive(),
      (e) => e.code === "VERIFIED_ACCOUNT_REQUIRED",
    );
  }
});

const MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const OPERATION = "33333333-3333-4333-8333-333333333333";

const archiveProposal = () => ({
  kind: "archive",
  messageId: "m1",
  expectedHistoryId: "4242",
});

test("owner mail dispatch retains unknown outcomes for unreadable and mismatched receipts", async (t) => {
  const google = { connectionId: GRANT_A, scopes: [READ_SCOPE, MODIFY_SCOPE] };
  const { routes, calls } = googleHost(t, google, { gmailOwnerWrites: true });
  const writer = routes.mailboxWriterForAccount({
    actorId: "owner",
    accountId: GRANT_A,
  });
  const receipt = {
    requestId: OPERATION,
    kind: "archive",
    reviewDigest: "a".repeat(64),
    state: "succeeded",
  };
  for (const response of [
    () => new Response("{"),
    () => Response.json({ receipt: { ...receipt, kind: "trash" } }),
    () =>
      Response.json({ receipt: { ...receipt, reviewDigest: "b".repeat(64) } }),
  ]) {
    google.operationResponse = response;
    const before = calls.filter((call) =>
      call.url.endsWith("/dispatch"),
    ).length;
    await assert.rejects(
      writer.dispatch({
        requestId: OPERATION,
        reviewDigest: receipt.reviewDigest,
        proposal: archiveProposal(),
      }),
      { code: "outcome_unknown" },
    );
    assert.equal(
      calls.filter((call) => call.url.endsWith("/dispatch")).length,
      before + 1,
    );
  }
});

test("owner mail reply is withheld when its Google grant changes in flight", async (t) => {
  const google = { connectionId: GRANT_A, scopes: [READ_SCOPE, MODIFY_SCOPE] };
  const { routes } = googleHost(t, google, { gmailOwnerWrites: true });
  const writer = routes.mailboxWriterForAccount({
    actorId: "owner",
    accountId: GRANT_A,
  });
  google.operationResponse = () => {
    google.connectionId = GRANT_B;
    return Response.json({
      receipt: {
        requestId: OPERATION,
        kind: "archive",
        reviewDigest: "a".repeat(64),
        state: "succeeded",
      },
    });
  };
  await assert.rejects(
    writer.dispatch({
      requestId: OPERATION,
      reviewDigest: "a".repeat(64),
      proposal: archiveProposal(),
    }),
    { code: "account_changed" },
  );
});

test("owner mail dispatch keeps an unknown outcome when final authority cannot be read", async (t) => {
  for (const afterDispatchStatus of [
    () => new Response(null, { status: 503 }),
    () => new Response("{"),
    () => {
      throw new DOMException("Timed out", "TimeoutError");
    },
  ]) {
    const google = {
      connectionId: GRANT_A,
      scopes: [READ_SCOPE, MODIFY_SCOPE],
      afterDispatchStatus,
    };
    const { routes, calls } = googleHost(t, google, { gmailOwnerWrites: true });
    const writer = routes.mailboxWriterForAccount({
      actorId: "owner",
      accountId: GRANT_A,
    });
    await assert.rejects(
      writer.dispatch({
        requestId: OPERATION,
        reviewDigest: "a".repeat(64),
        proposal: archiveProposal(),
      }),
      { code: "outcome_unknown" },
    );
    assert.equal(
      calls.filter((call) => call.url.endsWith("/dispatch")).length,
      1,
    );
  }
});

test("owner mail dispatch captures reviewed fields before credential awaits", async (t) => {
  const google = { connectionId: GRANT_A, scopes: [READ_SCOPE, MODIFY_SCOPE] };
  const { routes, calls } = googleHost(t, google, { gmailOwnerWrites: true });
  const writer = routes.mailboxWriterForAccount({
    actorId: "owner",
    accountId: GRANT_A,
  });
  const input = {
    requestId: OPERATION,
    reviewDigest: "a".repeat(64),
    proposal: archiveProposal(),
  };
  const pending = writer.dispatch(input);
  input.reviewDigest = "b".repeat(64);
  input.proposal.kind = "trash";
  input.proposal.messageId = "m2";
  const result = await pending;
  assert.equal(result.receipt.kind, "archive");
  assert.deepEqual(
    JSON.parse(calls.find((call) => call.url.endsWith("/dispatch")).init.body),
    {
      grantId: GRANT_A,
      reviewDigest: "a".repeat(64),
      proposal: archiveProposal(),
    },
  );
});

test("without the host opt-in, the owner's mailbox stays read-only and no writer exists", async (t) => {
  const google = { connectionId: GRANT_A };
  const { routes, calls, post, get } = googleHost(t, google);
  const status = await (await get("/gmail/status")).json();
  assert.equal("canChangeMessages" in status, false);
  assert.equal("canSendMessages" in status, false);
  assert.equal((await post("/gmail/connect", {})).status, 200);
  const consent = calls.find((c) => c.url.includes("/connect/initiate"));
  assert.deepEqual(JSON.parse(consent.init.body).capabilities, [
    "google.gmail.triage",
  ]);
  assert.throws(
    () =>
      routes.mailboxWriterForAccount({ actorId: "owner", accountId: GRANT_A }),
    { status: 403 },
  );
});

test("with the host opt-in, the owner grant holds modify and send and agent tasks still read mail", async (t) => {
  const google = {
    connectionId: GRANT_A,
    scopes: [READ_SCOPE, MODIFY_SCOPE, SEND_SCOPE, "openid"],
  };
  const { routes, calls, post, get } = googleHost(t, google, {
    gmailOwnerWrites: true,
  });
  const status = await (await get("/gmail/status")).json();
  assert.equal(status.canReadMessages, true);
  assert.equal(status.canChangeMessages, true);
  assert.equal(status.canSendMessages, true);
  assert.equal((await post("/gmail/connect", {})).status, 200);
  const consent = calls.find((c) => c.url.includes("/connect/initiate"));
  assert.deepEqual(JSON.parse(consent.init.body).capabilities, [
    "google.gmail.triage",
    "google.gmail.mailbox",
    "google.gmail.send",
  ]);
  // The owner's own list and mailbox projection read through the owner grant.
  assert.equal(
    (await post("/gmail/list", { query: "bill", grantId: GRANT_A })).status,
    200,
  );
  const mailbox = routes.mailboxForAccount({
    actorId: "owner",
    accountId: GRANT_A,
    retryDelaysMs: [],
  });
  await mailbox.list({ accountId: GRANT_A, query: "in:inbox", pageSize: 10 });
  // Agent task reads still read the owner's mail under the write grant.
  const tasks = routes.googleForAccount({
    actorId: "owner",
    retryDelaysMs: [],
  });
  assert.equal((await tasks.currentAccount()).accountId, GRANT_A);
  await tasks.searchGmailMessagesPage(search(GRANT_A));
  // Anything wider than read, modify and send is still refused everywhere.
  for (const wider of [
    [READ_SCOPE, MODIFY_SCOPE, "https://mail.google.com/"],
    [READ_SCOPE, "https://www.googleapis.com/auth/gmail.compose"],
    [MODIFY_SCOPE, SEND_SCOPE],
  ]) {
    google.scopes = wider;
    const widened = await (await get("/gmail/status")).json();
    assert.equal(widened.canReadMessages, false, wider.join(" "));
    await assert.rejects(
      tasks.currentAccount(),
      { code: "insufficient_scope" },
      wider.join(" "),
    );
    assert.equal(widened.canChangeMessages, false, wider.join(" "));
    assert.equal(widened.canSendMessages, false, wider.join(" "));
  }
  // A read-only grant still reads, and reports that it cannot change or send.
  google.scopes = [READ_SCOPE, "openid"];
  const readOnly = await (await get("/gmail/status")).json();
  assert.deepEqual(
    [
      readOnly.canReadMessages,
      readOnly.canChangeMessages,
      readOnly.canSendMessages,
    ],
    [true, false, false],
  );
  await tasks.currentAccount();
});

test("the owner mail writer relays Cloud's reviewed two-step operation for the current grant only", async (t) => {
  const google = {
    connectionId: GRANT_A,
    scopes: [READ_SCOPE, MODIFY_SCOPE, "openid"],
  };
  const { routes, calls } = googleHost(t, google, { gmailOwnerWrites: true });
  const writer = routes.mailboxWriterForAccount({
    actorId: "owner",
    accountId: GRANT_A,
  });
  const archive = {
    kind: "archive",
    messageId: "m1",
    expectedHistoryId: "4242",
  };
  const prepared = await writer.prepare({
    requestId: OPERATION,
    proposal: archive,
  });
  assert.equal(prepared.receipt.state, "prepared");
  assert.equal(prepared.receipt.mailbox, null);
  assert.deepEqual(prepared.review, { kind: "archive", messageId: "m1" });
  const prepare = calls.find((c) => c.url.endsWith("/inbox-v1/operations"));
  assert.equal(prepare.init.method, "POST");
  assert.deepEqual(JSON.parse(prepare.init.body), {
    grantId: GRANT_A,
    requestId: OPERATION,
    proposal: archive,
  });
  const done = await writer.dispatch({
    requestId: OPERATION,
    reviewDigest: prepared.receipt.reviewDigest,
    proposal: archive,
  });
  assert.equal(done.receipt.state, "succeeded");
  // The labels the change left, reduced as a read reduces them.
  assert.deepEqual(done.receipt.mailbox, {
    historyId: "4243",
    unread: true,
    inInbox: false,
    inTrash: false,
  });
  assert.ok(
    calls.some((c) =>
      c.url.endsWith(`/inbox-v1/operations/${OPERATION}/dispatch`),
    ),
  );
  assert.equal(
    (await writer.observe({ requestId: OPERATION })).receipt.requestId,
    OPERATION,
  );
  // Sending needs gmail.send, which this grant lacks: refused before Cloud.
  const before = calls.length;
  await assert.rejects(
    writer.prepare({
      requestId: OPERATION,
      proposal: { kind: "send", mode: "compose", to: ["a@example.test"] },
    }),
    { code: "insufficient_scope", status: 403 },
  );
  // Drafts and unknown effects are not offered by this host.
  await assert.rejects(
    writer.prepare({
      requestId: OPERATION,
      proposal: { kind: "draft-create" },
    }),
    { code: "refused", status: 400 },
  );
  await assert.rejects(
    writer.prepare({ requestId: "not-a-uuid", proposal: archive }),
    { code: "refused" },
  );
  assert.ok(
    !calls.slice(before).some((c) => c.url.includes("/inbox-v1/")),
    "No refused effect reached Cloud",
  );
  // A dispatch Cloud cannot answer is an unknown outcome, never retried.
  google.operationStatus = 503;
  const attempts = calls.length;
  await assert.rejects(
    writer.dispatch({
      requestId: OPERATION,
      reviewDigest: "a".repeat(64),
      proposal: archive,
    }),
    { code: "outcome_unknown" },
  );
  assert.equal(
    calls.slice(attempts).filter((c) => c.url.includes("/dispatch")).length,
    1,
  );
  google.operationStatus = 409;
  await assert.rejects(
    writer.dispatch({
      requestId: OPERATION,
      reviewDigest: "a".repeat(64),
      proposal: archive,
    }),
    { code: "review_changed", status: 409 },
  );
  google.operationStatus = undefined;
  // Cloud's attachment limits, read for the same current grant.
  assert.deepEqual(await writer.capabilities(), {
    version: 1,
    accountId: GRANT_A,
    attachmentPolicy: {
      mimeTypes: ["application/pdf", "image/png"],
      maximumBytes: 5242880,
      maximumOutgoing: 10,
      maximumTotalBytes: 5242880,
    },
  });
  assert.ok(
    calls.some((c) =>
      c.url.endsWith(`/inbox-v1/capabilities?grantId=${GRANT_A}`),
    ),
  );
  // A server without the policy is refused, never filled with copied limits.
  google.capabilities = { version: 1 };
  await assert.rejects(writer.capabilities(), { status: 502 });
  google.capabilities = undefined;
  // A failed Google token read is an outage, not a changed review.
  google.capabilitiesStatus = 409;
  await assert.rejects(writer.capabilities(), {
    code: "unavailable",
    status: 503,
  });
  google.capabilitiesStatus = undefined;
  // Another connected mailbox, or a revoked grant, is refused before Cloud.
  google.connectionId = GRANT_B;
  await assert.rejects(
    writer.prepare({ requestId: OPERATION, proposal: archive }),
    { code: "account_changed" },
  );
  await assert.rejects(writer.capabilities(), { code: "account_changed" });
  google.connectionId = GRANT_A;
  google.scopes = [READ_SCOPE, "openid"];
  await assert.rejects(
    writer.prepare({ requestId: OPERATION, proposal: archive }),
    { code: "insufficient_scope" },
  );
});

/** The routes over the real native enrollment and a fake Cloud. */
async function enrollmentRoutes(t, { hold } = {}) {
  const binding = {
    clientId: "org.example.native",
    environment: "test",
    redirectUri: "https://example.org/native/callback",
  };
  const later = () => new Date(Date.now() + 300000).toISOString();
  const revoked = [];
  let pending = null;
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      createNativeCloudAuth: (options) =>
        createEnrollment({
          ...options,
          auth: "https://auth.example.test",
          binding,
          appName: "Example Native",
        }),
    },
    pendingCredentialStore: {
      read: async () => pending,
      write: async (value) => {
        pending = value;
      },
      clear: async () => {
        pending = null;
      },
    },
    speechVoice: { voiceId: "voice", modelId: "model" },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      await hold?.(path);
      if (path.endsWith("/config"))
        return Response.json({
          ...binding,
          codeChallengeMethod: "S256",
          scopes: ["cloud:user"],
          app: { name: "Example Native" },
        });
      if (path === "/auth/email/send")
        return Response.json({ ok: true, data: { expiresAt: later() } });
      if (path === "/auth/email/code/verify")
        return Response.json({ ok: true, token: "synthetic-session-token" });
      if (path.endsWith("/connect"))
        return Response.json({
          codeType: "mobile_app_auth_code",
          code: "synthetic-grant",
          expiresAt: later(),
        });
      if (path.endsWith("/token"))
        return Response.json({
          credentialId: "22222222-2222-4222-8222-222222222222",
          secret: `eliza_mobile_${"a".repeat(64)}`,
          tokenType: "Bearer",
          acknowledgementRequired: true,
          acknowledgeBy: later(),
        });
      if (path.endsWith("/ack"))
        return Response.json({
          status: "acknowledged",
          credentialId: "22222222-2222-4222-8222-222222222222",
          expiresAt: later(),
        });
      if (path === "/api/v1/api-keys/current" && init.method === "DELETE") {
        revoked.push(init.headers.Authorization);
        return Response.json({
          success: true,
          status: "revoked",
          credentialId: "22222222-2222-4222-8222-222222222222",
          revokedAt: new Date().toISOString(),
        });
      }
      throw Error(`Unexpected provider request ${path}`);
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
  const post = (path, input = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  const status = async () =>
    (
      await fetch(`http://127.0.0.1:${server.address().port}/cloud/status`)
    ).json();
  return { post, status, revoked };
}

test("a sign-in cancel never disconnects the account a finished sign-in reported", async (t) => {
  const { post, status, revoked } = await enrollmentRoutes(t);
  const begun = await (
    await post("/cloud/native/start", { email: "synthetic@example.com" })
  ).json();
  const verified = await post("/cloud/native/verify", {
    sessionId: begun.sessionId,
    code: "123456",
  });
  assert.equal((await verified.json()).connected, true);
  // A late Stop, park or Close of the set-up screen.
  const cancelled = await post("/cloud/native/cancel");
  assert.equal(cancelled.status, 200);
  assert.deepEqual(revoked, []);
  assert.equal((await status()).connected, true);
  // Disconnecting stays its own route.
  assert.equal((await post("/cloud/logout")).status, 200);
  assert.equal(revoked.length, 1);
  assert.equal((await status()).connected, false);
});

test("a sign-in request refused while the host is busy names the conflict", async (t) => {
  let release, entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { post } = await enrollmentRoutes(t, {
    hold: async (path) => {
      if (path === "/auth/email/send") {
        entered();
        await gate;
      }
    },
  });
  const starting = post("/cloud/native/start", {
    email: "synthetic@example.com",
  });
  await reached;
  const busy = await post("/cloud/native/start", {
    email: "synthetic@example.com",
  });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, "sign_in_busy");
  release();
  assert.equal((await starting).status, 200);
});

test("the owner mail writer refuses a send review it cannot show the owner", async (t) => {
  const google = {
    connectionId: GRANT_A,
    scopes: [READ_SCOPE, SEND_SCOPE, "openid"],
  };
  const { routes } = googleHost(t, google, { gmailOwnerWrites: true });
  const writer = routes.mailboxWriterForAccount({
    actorId: "owner",
    accountId: GRANT_A,
  });
  const review = {
    kind: "send",
    from: "owner@example.test",
    to: ["ann@example.test"],
    cc: [],
    subject: "Hello",
    attachments: [{ name: "bill.pdf" }],
  };
  const answer = (value) => () =>
    Response.json({
      receipt: {
        requestId: OPERATION,
        kind: "send",
        reviewDigest: "a".repeat(64),
        state: "prepared",
      },
      review: value,
    });
  const proposal = {
    kind: "send",
    mode: "compose",
    to: ["ann@example.test"],
    subject: "Hello",
    bodyText: "Hi",
  };
  // Cloud sends with cc or bcc alone.
  for (const valid of [
    review,
    { ...review, to: [], bcc: ["b@example.test"] },
  ]) {
    google.operationResponse = answer(valid);
    assert.deepEqual(
      (await writer.prepare({ requestId: OPERATION, proposal })).review,
      valid,
    );
  }
  for (const malformed of [
    { ...review, from: "Owner <owner@example.test>" },
    { ...review, to: [] },
    { ...review, bcc: ["ann..b@example.test"] },
    { ...review, cc: Array(50).fill("b@example.test") },
    { ...review, to: ["ann..b@example.test"] },
    { ...review, cc: "ann@example.test" },
    { ...review, subject: undefined },
    { ...review, attachments: [{ size: 4 }] },
    { ...review, forwardedAttachments: {} },
    { ...review, kind: "archive" },
  ]) {
    google.operationResponse = answer(malformed);
    await assert.rejects(writer.prepare({ requestId: OPERATION, proposal }), {
      status: 502,
    });
  }
});

// A Cloud stand-in for the paid-access cache. `plans` maps each key to the
// state its billing snapshot projects; an unknown key is refused at /user.
// `hold` (when set) keeps every account call waiting until it resolves.
async function paidAccessHarness(t) {
  const plans = new Map([["key-a", "active"]]);
  const calls = [];
  const control = { hold: null, ttsStatus: 200, saved: "key-a" };
  const routes = createCloudRoutes({
    hostPolicy: {
      ...policy,
      projectAccountAccess: (user, snapshot) => ({
        state: snapshot.plan,
        user: user.id,
      }),
      fundingError: (access) =>
        Object.assign(new Error(`Funding ${access.state}`), {
          status: 402,
          access,
        }),
    },
    credentialStore: {
      read: async () => {
        const value = control.saved;
        await control.afterRead?.();
        return value;
      },
      write: async (value) => {
        control.saved = value;
      },
      clear: async () => {
        control.saved = null;
      },
    },
    speechVoice: { voiceId: "voice", modelId: "model" },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname,
        key = init.headers.Authorization?.slice("Bearer ".length);
      calls.push({ path, key });
      if (path === "/api/v1/user" || path === "/api/v1/billing/limits") {
        await control.hold;
        if (!plans.has(key)) return Response.json({}, { status: 401 });
        return Response.json(
          path === "/api/v1/user" ? { id: key } : { plan: plans.get(key) },
        );
      }
      if (path === "/api/v1/voice/tts")
        return control.ttsStatus === 200
          ? new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-type": "audio/mpeg" },
            })
          : Response.json({}, { status: control.ttsStatus });
      if (path === "/api/auth/cli-session")
        return Response.json({
          sessionId: "abcdefghijklmnop1234",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
      throw Error(`Unexpected provider request ${path}`);
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
  const post = (route, value = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  const accountCalls = () =>
    calls.filter(
      ({ path }) =>
        path === "/api/v1/user" || path === "/api/v1/billing/limits",
    );
  return { routes, plans, calls, accountCalls, control, base, post };
}

test("a warm paid check asks Cloud nothing and refreshes the cache afterwards", async (t) => {
  const { routes, plans, accountCalls } = await paidAccessHarness(t);
  // Cold: nothing cached for this key, so Cloud is asked first (both calls).
  await routes.requirePaidAccess();
  assert.deepEqual(
    accountCalls()
      .map(({ path }) => path)
      .sort(),
    ["/api/v1/billing/limits", "/api/v1/user"],
  );
  await routes.paidAccessSettled();
  const cold = accountCalls().length;
  // Warm: the request is admitted with no Cloud call on its path.
  const served = routes.requirePaidAccess();
  const during = accountCalls().length;
  await served;
  assert.equal(accountCalls().length, cold, "no Cloud call before admission");
  assert.equal(during, cold);
  // After it, one background check refreshes the cache.
  await routes.paidAccessSettled();
  assert.equal(accountCalls().length, cold + 2);
  // The plan lapses: the background check learns it, so the next request
  // asks Cloud again before refusing, and refuses.
  plans.set("key-a", "plan_required");
  await routes.requirePaidAccess();
  await routes.paidAccessSettled();
  const lapsed = accountCalls().length;
  await assert.rejects(routes.requirePaidAccess(), /Funding plan_required/);
  assert.equal(
    accountCalls().length,
    lapsed + 2,
    "a refusal is re-checked live",
  );
});

test("a cached refusal is checked live, so an upgrade admits the next request at once", async (t) => {
  const { routes, plans, accountCalls } = await paidAccessHarness(t);
  plans.set("key-a", "plan_required");
  await assert.rejects(routes.requirePaidAccess(), /Funding plan_required/);
  // She upgrades on another device. The cached answer still refuses, so the
  // next request asks Cloud before refusing, and Cloud now says active.
  plans.set("key-a", "active");
  const before = accountCalls().length;
  await routes.requirePaidAccess();
  assert.equal(accountCalls().length, before + 2);
  // And that answer is now cached.
  await routes.paidAccessSettled();
  const warm = accountCalls().length;
  await routes.requirePaidAccess();
  assert.equal(accountCalls().length, warm);
  await routes.paidAccessSettled();
});

test("the paid-access cache never answers for another account", async (t) => {
  const { routes, plans, control, accountCalls } = await paidAccessHarness(t);
  await routes.requirePaidAccess();
  await routes.paidAccessSettled();
  // Another account's key is saved by the host, outside these routes.
  plans.set("key-b", "plan_required");
  control.saved = "key-b";
  const before = accountCalls().length;
  await assert.rejects(routes.requirePaidAccess(), /Funding plan_required/);
  assert.ok(
    accountCalls()
      .slice(before)
      .every(({ key }) => key === "key-b"),
  );
  assert.equal(accountCalls().length, before + 2);
  // Back to the first key: the cache now holds key-b's refusal, so key-a is
  // checked live again before it is admitted.
  control.saved = "key-a";
  const back = accountCalls().length;
  await routes.requirePaidAccess();
  assert.equal(accountCalls().length, back + 2);
  await routes.paidAccessSettled();

  // A host may replace the credential while its asynchronous read settles.
  // The admitted request must not silently retarget to the replacement.
  const fresh = await paidAccessHarness(t);
  fresh.plans.set("key-a", "plan_required");
  fresh.plans.set("key-b", "active");
  let reads = 0;
  fresh.control.afterRead = () => {
    if (++reads === 1) fresh.control.saved = "key-b";
  };
  await assert.rejects(fresh.routes.requirePaidAccess(), { status: 409 });
  assert.ok(fresh.accountCalls().every(({ key }) => key === "key-a"));
});

test("a late identity refusal keeps a replacement private-file credential", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-paid-owner-"));
  const store = createFileCredentialStore(join(directory, "credential"));
  await store.write("key-a");
  const seen = Promise.withResolvers();
  const release = Promise.withResolvers();
  const revocationSeen = Promise.withResolvers();
  const releaseRevocation = Promise.withResolvers();
  let holdRevocation = false;
  const cloud = http.createServer(async (req, res) => {
    const key = req.headers.authorization?.slice("Bearer ".length);
    if (req.url === "/api/v1/user" && key === "key-a") {
      seen.resolve();
      await release.promise;
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/api/v1/user" ? { id: key } : { plan: "active" },
        ),
      );
    }
  });
  t.after(async () => {
    release.resolve();
    releaseRevocation.resolve();
    cloud.closeAllConnections();
    await new Promise((resolve) => cloud.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  cloud.listen(0, "127.0.0.1");
  await once(cloud, "listening");
  const routes = createCloudRoutes({
    credentialStore: store,
    credentialRevocation: {
      onRevoked: async () => {
        if (holdRevocation) {
          revocationSeen.resolve();
          await releaseRevocation.promise;
        }
      },
      status: () => ({ revoked: false }),
    },
    hostPolicy: policy,
    // Real loopback HTTP stands in for the trusted Cloud origin; production
    // HTTPS origin and response validation remain unchanged.
    fetchImpl: (url, init) =>
      fetch(
        `http://127.0.0.1:${cloud.address().port}${new URL(url).pathname}`,
        init,
      ),
    speechVoice: { voiceId: "voice", modelId: "model" },
  });
  const pending = routes.accountAccess().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await seen.promise;
  await store.write("key-b");
  release.resolve();
  const outcome = await pending;
  assert.equal(outcome.error?.status, 409);
  assert.equal(await store.read(), "key-b");
  await routes.requirePaidAccess();
  await routes.paidAccessSettled();

  // The host's asynchronous revocation receipt must not clear a key saved
  // while that receipt was being recorded.
  holdRevocation = true;
  await store.write("key-a");
  const duringRevocation = routes.accountAccess().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await revocationSeen.promise;
  await store.write("key-b");
  releaseRevocation.resolve();
  const lateOutcome = await duringRevocation;
  assert.equal(lateOutcome.error?.status, 409);
  assert.equal(await store.read(), "key-b");
  assert.equal(await store.clear("key-a"), false);
  assert.equal(await store.read(), "key-b");
});

test("one live check serves concurrent cold requests, and background checks coalesce", async (t) => {
  const { routes, control, accountCalls } = await paidAccessHarness(t);
  let release;
  control.hold = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = [1, 2, 3, 4].map(() => routes.requirePaidAccess());
  // Both calls of the one check are in flight together (parallel, not in turn).
  while (accountCalls().length < 2) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(accountCalls().length, 2);
  release();
  control.hold = null;
  await Promise.all(waiting);
  assert.equal(accountCalls().length, 2);
  // Many served requests at once schedule a single background check.
  await Promise.all([1, 2, 3, 4, 5].map(() => routes.requirePaidAccess()));
  await routes.paidAccessSettled();
  assert.equal(accountCalls().length, 4);
});

test("sign-out, sign-in, revocation and a refused paid call drop the cached answer", async (t) => {
  const { routes, plans, control, accountCalls, post } =
    await paidAccessHarness(t);
  const warm = async () => {
    await routes.requirePaidAccess();
    await routes.paidAccessSettled();
    const before = accountCalls().length;
    await routes.requirePaidAccess();
    assert.equal(accountCalls().length, before, "warm");
    await routes.paidAccessSettled();
  };
  const coldNext = async (name) => {
    const before = accountCalls().length;
    await routes.requirePaidAccess();
    assert.equal(accountCalls().length, before + 2, name);
    await routes.paidAccessSettled();
  };
  await warm();
  // Logout clears the key; a signed-out request is refused without Cloud.
  assert.equal((await post("/cloud/logout")).status, 200);
  const signedOut = accountCalls().length;
  await assert.rejects(routes.requirePaidAccess(), /Funding signed_out/);
  assert.equal(accountCalls().length, signedOut);
  control.saved = "key-a";
  await coldNext("after logout");

  await warm();
  assert.equal((await post("/cloud/login")).status, 200);
  control.saved = "key-a";
  await coldNext("after login");

  // A paid Cloud call refused with 402 drops the answer and re-checks.
  await warm();
  control.ttsStatus = 402;
  assert.equal((await post("/voice/tts", { text: "hello" })).status, 402);
  control.ttsStatus = 200;
  await routes.paidAccessSettled();
  // The background re-check filled the cache again: the next one is warm.
  const refilled = accountCalls().length;
  await routes.requirePaidAccess();
  assert.equal(accountCalls().length, refilled);
  await routes.paidAccessSettled();

  // The host reports a refusal it saw (the agent's own Cloud call).
  routes.paidAccessRefused();
  await routes.paidAccessSettled();
  plans.delete("key-a");
  // Revoked elsewhere: the next background check is refused at /user, the key
  // is cleared, and the next request is refused without serving the cache.
  await routes.requirePaidAccess();
  await routes.paidAccessSettled();
  assert.equal(control.saved, null);
  await assert.rejects(routes.requirePaidAccess(), /Funding signed_out/);
});

test("a refusal during a background check schedules another, and settling waits for it", async (t) => {
  const { routes, control, accountCalls } = await paidAccessHarness(t);
  await routes.requirePaidAccess();
  await routes.paidAccessSettled();
  // A warm request schedules a background check; hold it in flight.
  let release;
  control.hold = new Promise((resolve) => {
    release = resolve;
  });
  const before = accountCalls().length;
  await routes.requirePaidAccess();
  assert.equal(accountCalls().length, before, "warm");
  while (accountCalls().length < before + 2)
    await new Promise((r) => setImmediate(r));
  // The agent's own Cloud call is refused while that check is in flight. Its
  // answer belongs to the dropped epoch and cannot fill the cache, so another
  // check must be scheduled for the current one.
  routes.paidAccessRefused();
  control.hold = null;
  let settled = false;
  const settling = routes.paidAccessSettled().then(() => {
    settled = true;
  });
  release();
  await settling;
  assert.ok(settled);
  assert.equal(
    accountCalls().length,
    before + 4,
    "a second background check ran for the current epoch before settling",
  );
  // That check filled the cache: the next request asks Cloud nothing.
  const refilled = accountCalls().length;
  await routes.requirePaidAccess();
  assert.equal(accountCalls().length, refilled, "warm after the refusal");
  await routes.paidAccessSettled();
});

test("the access route shares the live check and keeps the paid cache warm", async (t) => {
  const { routes, accountCalls, base } = await paidAccessHarness(t);
  const answer = await (await fetch(`${base}/cloud/account/access`)).json();
  assert.deepEqual(answer, { state: "active", user: "key-a" });
  const before = accountCalls().length;
  await routes.requirePaidAccess();
  assert.equal(accountCalls().length, before);
  await routes.paidAccessSettled();
});
