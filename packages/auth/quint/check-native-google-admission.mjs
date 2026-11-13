/** Checks the native Google admission boundary with existing tests and HTTP. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import {
  createNativeCloudAuth,
  SIGN_IN_CONFLICT,
} from "../native-host/cloud-enrollment.mjs";

const test = fileURLToPath(
  new URL("../native-host/cloud-enrollment-google.test.mjs", import.meta.url),
);
const output = testOutputPath("quint-native-google-admission");
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, "run-"));
const maintained = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", test],
  {
    encoding: "utf8",
    timeout: 120_000,
  },
);
fs.writeFileSync(
  path.join(directory, "maintained-tests.tap"),
  maintained.stdout ?? "",
);
if (maintained.error) throw maintained.error;
assert.equal(maintained.status, 0, maintained.stderr);
assert.match(maintained.stdout, /^# skipped 0$/m);
for (const name of [
  "a matched Google return is single use",
  "a return for another attempt neither completes nor cancels the current one",
  "malformed Google returns are refused before any exchange",
  "Steward's failure link ends the attempt without an exchange",
  "Google attempts expire with Steward's authorize state and on cancel",
  "a second factor from the Google exchange finishes in-app through MFA",
  "Google MFA retry uses the current private challenge and cancellation fences grant dispatch",
  "Google MFA refuses an expired challenge at its exact deadline",
]) {
  assert(
    maintained.stdout
      .split("\n")
      .some((line) => /^ok \d+ - /.test(line) && line.endsWith(name)),
    name,
  );
}

const binding = {
  clientId: "org.example.native",
  environment: "test",
  redirectUri: "https://example.test/native",
};
const receipt = Promise.withResolvers();
const release = Promise.withResolvers();
const unexpected = [];
let exchanges = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const send = (body) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/v1/app-auth/mobile/config") {
    send({ ...binding, codeChallengeMethod: "S256", scopes: ["cloud:user"] });
  } else if (url.pathname === "/auth/oauth/exchange") {
    exchanges++;
    let body = "";
    for await (const chunk of request) body += chunk;
    receipt.resolve(JSON.parse(body));
    await release.promise;
    send({
      ok: true,
      mfaRequired: true,
      mfa: {
        type: "totp",
        challengeId: "fixture-challenge",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  } else {
    unexpected.push(url.pathname);
    response.statusCode = 404;
    send({ ok: false });
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const redirect = `${origin}/google/return`;
  const host = createNativeCloudAuth({
    api: origin,
    auth: origin,
    binding,
    googleRedirectUri: redirect,
    appName: "Fixture",
    pendingStore: {
      read: async () => null,
      write: async () =>
        assert.fail("cancelled callback cannot write a receipt"),
      clear: async () => {},
    },
    activate: async () => assert.fail("cancelled callback cannot activate"),
  });
  const started = await host.handle("start", { method: "google" });
  assert.equal(started.status, "browser");
  const authorize = new URL(started.url);
  const code = "fixture-google-code-000000000001";
  const callbackUrl = `${redirect}#${new URLSearchParams({ code, state: authorize.searchParams.get("state") })}`;
  const returned = host.handle("google-return", { callbackUrl });
  const rejected = assert.rejects(returned, {
    status: 409,
    code: SIGN_IN_CONFLICT.cancelled,
  });
  const body = await Promise.race([
    receipt.promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Exchange did not reach loopback")),
        5000,
      ).unref(),
    ),
  ]);
  assert.equal(body.code, code);
  assert.equal(
    createHash("sha256").update(body.code_verifier).digest("base64url"),
    authorize.searchParams.get("code_challenge"),
  );
  const cancelled = host.cancel();
  release.resolve();
  await rejected;
  assert.deepEqual(await cancelled, { status: "cancelled" });
  await assert.rejects(host.handle("google-return", { callbackUrl }), {
    status: 410,
  });
  assert.equal(exchanges, 1);
  assert.deepEqual(unexpected, []);
} finally {
  release.resolve();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log(
  `Native Google admission passed maintained tests and a loopback cancel race. Evidence ${directory}`,
);
