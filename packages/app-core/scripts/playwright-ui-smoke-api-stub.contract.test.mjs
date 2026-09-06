/**
 * Contract coverage for the keyless UI-smoke server's read-only designed-empty
 * surfaces and its fail-closed write/item boundary.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { VOICE_MODEL_VERSIONS } from "../../shared/src/local-inference/voice-models.ts";

const stubUrl = new URL("./playwright-ui-smoke-api-stub.mjs", import.meta.url);
let child;
let origin;

async function waitForStubReady(processHandle) {
  let output = "";
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      processHandle.off("error", onError);
      processHandle.off("exit", onExit);
      processHandle.stdout.off("data", onOutput);
      processHandle.stderr.off("data", onErrorOutput);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) =>
      fail(
        new Error(
          `UI smoke stub exited before ready: code=${code} signal=${signal} ${output}`,
        ),
      );
    const onErrorOutput = (chunk) => {
      output += chunk.toString();
    };
    const onOutput = (chunk) => {
      output += chunk.toString();
      const address = output.match(
        /listening on (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1];
      if (!address) return;
      cleanup();
      resolve(address);
    };
    const timer = setTimeout(
      () => fail(new Error(`UI smoke stub did not become ready: ${output}`)),
      15_000,
    );
    processHandle.once("error", onError);
    processHandle.once("exit", onExit);
    processHandle.stdout.on("data", onOutput);
    processHandle.stderr.on("data", onErrorOutput);
  });
}

beforeAll(async () => {
  child = spawn(process.execPath, [fileURLToPath(stubUrl)], {
    env: {
      ...process.env,
      ELIZA_UI_SMOKE_API_PORT: "0",
      ELIZA_UI_SMOKE_STUB_IGNORE_SIGTERM: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await waitForStubReady(child);
  child.stdout.resume();
  child.stderr.resume();
});

afterAll(async () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const forceStop = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    child.kill("SIGTERM");
    await exited;
  } finally {
    clearTimeout(forceStop);
  }
});

async function jsonGet(pathname) {
  const response = await fetch(`${origin}${pathname}`);
  assert.equal(response.status, 200, pathname);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  return response.json();
}

it("serves truthful designed-empty local inference and owner surfaces", async () => {
  const auth = await jsonGet("/api/auth/me");
  assert.equal(auth.identity.kind, "owner");

  const streamResponse = await fetch(
    `${origin}/api/local-inference/device/stream?token=smoke-owner`,
  );
  assert.equal(streamResponse.status, 200);
  assert.match(
    streamResponse.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  const streamBody = await streamResponse.text();
  assert.match(streamBody, /^retry: 60000\ndata: /);
  const streamPayload = JSON.parse(
    streamBody.match(/data: (.+)\n/)?.[1] ?? "null",
  );
  assert.deepEqual(streamPayload, {
    type: "status",
    status: {
      connected: false,
      devices: [],
      primaryDeviceId: null,
      pendingRequests: 0,
      deviceId: null,
      capabilities: null,
      loadedPath: null,
      connectedSince: null,
    },
  });

  assert.deepEqual(
    await jsonGet("/api/local-inference/voice-models/preferences"),
    {
      preferences: {
        autoUpdateOnWifi: true,
        autoUpdateOnCellular: false,
        autoUpdateOnMetered: false,
        quietHours: [{ start: "22:00", end: "08:00" }],
      },
      isOwner: true,
    },
  );
  assert.deepEqual(await jsonGet("/api/accounts/consumer-keys"), {
    keys: [],
  });

  const protection = await jsonGet("/api/secrets/manager/protection");
  assert.equal(protection.ok, true);
  assert.deepEqual(protection.protection.localVault.masterKey, {
    backend: "none",
    available: false,
    synchronized: false,
    scope: "unavailable",
    access: "unavailable",
  });
  assert.equal(protection.protection.localVault.encryptedAtRest, true);
  assert.equal(
    protection.protection.nativeSessionState.plaintextFallback,
    false,
  );

  assert.deepEqual(await jsonGet("/api/secrets/logins"), {
    ok: true,
    logins: [],
    failures: [],
  });
});

it("lists every known voice model as uninstalled without fabricating readiness", async () => {
  const { installations } = await jsonGet("/api/local-inference/voice-models");
  const ids = installations.map((installation) => installation.id);
  expect(ids).toContain("kokoro");
  expect(ids).toContain("asr");
  expect(ids).toEqual(
    [...new Set(VOICE_MODEL_VERSIONS.map((version) => version.id))].sort(),
  );
  for (const installation of installations) {
    expect(installation).toEqual({
      id: installation.id,
      installedVersion: null,
      pinned: false,
      lastError: null,
    });
  }
});

it("does not fabricate write or item-route authority", async () => {
  for (const [method, pathname] of [
    ["POST", "/api/accounts/consumer-keys"],
    ["PATCH", "/api/accounts/consumer-keys/smoke-key"],
    ["GET", "/api/accounts/consumer-keys/smoke-key"],
    ["POST", "/api/accounts/consumer-keys/smoke-key/rotate"],
    ["POST", "/api/local-inference/device/stream"],
    ["GET", "/api/local-inference/voice-models/check"],
    ["POST", "/api/local-inference/voice-models/preferences"],
    ["POST", "/api/local-inference/voice-models/smoke-model/update"],
    ["POST", "/api/local-inference/voice-models/smoke-model/pin"],
    ["POST", "/api/secrets/manager/protection"],
    ["POST", "/api/secrets/logins"],
    ["GET", "/api/secrets/logins/example.test/user"],
    ["DELETE", "/api/secrets/logins/example.test/user"],
    ["PUT", "/api/secrets/logins/example.test/autoallow"],
  ]) {
    const response = await fetch(`${origin}${pathname}`, { method });
    expect(response.status, `${method} ${pathname}`).toBe(501);
  }
});
