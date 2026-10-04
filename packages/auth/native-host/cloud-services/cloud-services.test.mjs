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
