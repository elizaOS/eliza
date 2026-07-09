/** GitHub device-flow protocol tests use injected responses and no network. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearGitHubDeviceLoginsForTest,
  pollGitHubDeviceLogin,
  startGitHubDeviceLogin,
} from "./github-device-login.mjs";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.afterEach(() => clearGitHubDeviceLoginsForTest());

test("device flow keeps the device code server-side and returns the token once", async () => {
  let nowMs = 1_000;
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, body: String(init.body) });
    if (requests.length === 1) {
      return response({
        device_code: "secret-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    }
    if (requests.length === 2)
      return response({ error: "authorization_pending" });
    return response({
      access_token: "gho_live_token_value",
      token_type: "bearer",
      scope: "repo,read:user",
    });
  };
  const started = await startGitHubDeviceLogin({
    clientId: "client-1",
    target: "home",
    fetchFn,
    now: () => nowMs,
    randomBytesFn: () => Buffer.from("opaque-flow-id"),
  });
  assert.deepEqual(started, {
    flowId: Buffer.from("opaque-flow-id").toString("base64url"),
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
    intervalSeconds: 5,
    expiresInSeconds: 900,
  });
  assert.equal(JSON.stringify(started).includes("secret-device-code"), false);

  assert.deepEqual(
    await pollGitHubDeviceLogin({
      flowId: started.flowId,
      fetchFn,
      now: () => nowMs,
    }),
    { status: "pending", retryAfterSeconds: 5 },
  );
  nowMs += 5_000;
  const completed = await pollGitHubDeviceLogin({
    flowId: started.flowId,
    fetchFn,
    now: () => nowMs,
  });
  assert.deepEqual(completed, {
    status: "complete",
    token: "gho_live_token_value",
    target: "home",
    tokenType: "bearer",
    scope: "repo,read:user",
  });
  await assert.rejects(
    pollGitHubDeviceLogin({
      flowId: started.flowId,
      fetchFn,
      now: () => nowMs,
    }),
    /unknown or expired/,
  );
  assert.match(requests[1].body, /device_code=secret-device-code/);
});

test("slow_down raises the server-owned polling interval", async () => {
  let nowMs = 10_000;
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return calls === 1
      ? response({
          device_code: "device",
          user_code: "CODE",
          verification_uri: "https://github.com/login/device",
          expires_in: 60,
          interval: 2,
        })
      : response({ error: "slow_down" });
  };
  const started = await startGitHubDeviceLogin({
    clientId: "client",
    target: "repo",
    fetchFn,
    now: () => nowMs,
  });
  assert.deepEqual(
    await pollGitHubDeviceLogin({
      flowId: started.flowId,
      fetchFn,
      now: () => nowMs,
    }),
    { status: "pending", retryAfterSeconds: 7 },
  );
  nowMs += 1_000;
  assert.deepEqual(
    await pollGitHubDeviceLogin({
      flowId: started.flowId,
      fetchFn,
      now: () => nowMs,
    }),
    { status: "pending", retryAfterSeconds: 6 },
  );
  assert.equal(calls, 2);
});

test("missing client registration is an explicit owner-setup state", async () => {
  await assert.rejects(
    startGitHubDeviceLogin({ clientId: "", target: "home" }),
    /needs owner setup/,
  );
});
