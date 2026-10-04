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
  const routes = createCloudRoutes({
    hostPolicy: policy,
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
