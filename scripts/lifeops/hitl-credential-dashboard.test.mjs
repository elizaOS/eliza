/**
 * Loopback integration coverage for the HITL credential dashboard's write
 * boundary. The test starts the real dashboard process with an isolated HOME so
 * forged browser-style POSTs can prove they do not mutate any operator env file.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  dashboardErrorResponse,
  HttpError,
} from "./hitl-credential-dashboard.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

test("credential dashboard does not serialize unexpected exception details", () => {
  const marker = "<script>internal/path/database.sql</script>";
  const error = new Error(marker);
  error.stack = `Error: ${marker}\n    at /private/service.ts:42:7`;

  assert.deepEqual(dashboardErrorResponse(error), {
    status: 500,
    body: { error: "Credential dashboard request failed" },
  });
});

test("credential dashboard contains hostile thrown proxies", () => {
  const hostile = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw new Error("prototype secret");
    },
    get() {
      throw new Error("getter secret");
    },
  });

  assert.deepEqual(dashboardErrorResponse(hostile), {
    status: 500,
    body: { error: "Credential dashboard request failed" },
  });
});

test("credential dashboard bounds and escapes typed client errors", () => {
  const marker = `bad\n\u202e${"x".repeat(2_000)}`;
  const response = dashboardErrorResponse(new HttpError(400, marker));

  assert.equal(response.status, 400);
  assert.match(response.body.error, /^bad\\u\{a\}\\u\{202e\}/);
  assert.match(response.body.error, /…\[truncated\]$/);
  assert.ok(response.body.error.length < 600);
  assert.doesNotMatch(response.body.error, /[\n\u202e]/u);
});

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function waitForDashboard(child) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`dashboard did not start:\n${output}`));
    }, 20_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      resolvePromise(match[1]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `dashboard exited before listening: status=${status} signal=${signal}\n${output}`,
        ),
      );
    });
  });
}

async function stopDashboard(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => {
    child.once("exit", resolvePromise);
  });
  child.kill("SIGTERM");
  await exited;
}

async function postEnv(baseUrl, headers, value) {
  return fetch(`${baseUrl}api/env`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      key: "TELEGRAM_BOT_TOKEN",
      value,
      target: "home",
    }),
  });
}

test("credential dashboard rejects cross-site writes and requires its page session", async () => {
  const home = tempDir("hitl-dashboard-home-");
  const child = spawn(
    "node",
    ["scripts/lifeops/hitl-credential-dashboard.mjs"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const envPath = join(home, ".eliza", ".env");
  try {
    const baseUrl = await waitForDashboard(child);
    const sameOrigin = new URL(baseUrl).origin;

    const forged = await postEnv(
      baseUrl,
      { Origin: "http://attacker.invalid" },
      "attacker-token",
    );
    assert.equal(forged.status, 403);
    assert.equal(existsSync(envPath), false);

    const pageResponse = await fetch(baseUrl);
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    const tokenMatch = /var SESSION_TOKEN = "([^"]+)";/.exec(pageHtml);
    assert.ok(tokenMatch, "dashboard page exposes a per-process session token");

    const missingToken = await postEnv(
      baseUrl,
      { Origin: sameOrigin },
      "missing-session-token",
    );
    assert.equal(missingToken.status, 403);
    assert.equal(existsSync(envPath), false);

    const wrongContentType = await fetch(`${baseUrl}api/env`, {
      method: "POST",
      headers: {
        Origin: sameOrigin,
        "Content-Type": "text/plain",
        "X-HITL-Session": tokenMatch[1],
      },
      body: JSON.stringify({
        key: "TELEGRAM_BOT_TOKEN",
        value: "wrong-content-type",
        target: "home",
      }),
    });
    assert.equal(wrongContentType.status, 415);
    assert.equal(existsSync(envPath), false);

    const saved = await postEnv(
      baseUrl,
      { Origin: sameOrigin, "X-HITL-Session": tokenMatch[1] },
      "operator-token-value",
    );
    assert.equal(saved.status, 200);
    assert.match(
      readFileSync(envPath, "utf8"),
      /TELEGRAM_BOT_TOKEN=operator-token-value/,
    );
  } finally {
    await stopDashboard(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test("discord loopback OAuth surfaces fail closed without registration or a known state", async () => {
  const home = tempDir("hitl-dashboard-home-");
  const child = spawn(
    "node",
    ["scripts/lifeops/hitl-credential-dashboard.mjs"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const envPath = join(home, ".eliza", ".env");
  try {
    const baseUrl = await waitForDashboard(child);
    const sameOrigin = new URL(baseUrl).origin;
    const pageHtml = await (await fetch(baseUrl)).text();
    const tokenMatch = /var SESSION_TOKEN = "([^"]+)";/.exec(pageHtml);
    assert.ok(tokenMatch);

    // No Discord OAuth app registered in the isolated HOME: the start
    // endpoint is the designed needs-owner-setup state, not a broken flow.
    const start = await fetch(`${baseUrl}api/oneclick/discord-oauth/start`, {
      method: "POST",
      headers: {
        Origin: sameOrigin,
        "Content-Type": "application/json",
        "X-HITL-Session": tokenMatch[1],
      },
      body: JSON.stringify({ target: "home" }),
    });
    assert.equal(start.status, 409);
    const startPayload = await start.json();
    assert.match(startPayload.error, /needs owner setup/);

    // A forged callback state is rejected without any credential write and
    // without echoing anything sensitive.
    const callback = await fetch(
      `${baseUrl}oauth/discord/callback?state=forged&code=x`,
    );
    assert.equal(callback.status, 400);
    const callbackHtml = await callback.text();
    assert.match(callbackHtml, /unknown or expired/);
    assert.equal(existsSync(envPath), false);

    const authHeaders = {
      Origin: sameOrigin,
      "Content-Type": "application/json",
      "X-HITL-Session": tokenMatch[1],
    };
    for (const [key, value] of [
      ["DISCORD_CLIENT_ID", "123456789"],
      ["DISCORD_CLIENT_SECRET", "test-only-secret"],
    ]) {
      const saved = await fetch(`${baseUrl}api/env`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ key, value, target: "home" }),
      });
      assert.equal(saved.status, 200);
    }

    const registeredStart = await fetch(
      `${baseUrl}api/oneclick/discord-oauth/start`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ target: "home" }),
      },
    );
    assert.equal(registeredStart.status, 200);
    const { authorizeUrl } = await registeredStart.json();
    const state = new URL(authorizeUrl).searchParams.get("state");
    assert.ok(state);

    const payload = `<img src=x onerror=alert(1)>"'&`;
    const hostileCallback = await fetch(
      `${baseUrl}oauth/discord/callback?state=${encodeURIComponent(state)}&error=${encodeURIComponent(payload)}`,
    );
    assert.equal(hostileCallback.status, 400);
    const hostileCallbackHtml = await hostileCallback.text();
    assert.doesNotMatch(hostileCallbackHtml, /<img src=x/);
    assert.match(
      hostileCallbackHtml,
      /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/,
    );
  } finally {
    await stopDashboard(child);
    rmSync(home, { recursive: true, force: true });
  }
});
