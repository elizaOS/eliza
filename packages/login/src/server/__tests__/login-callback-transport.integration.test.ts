/**
 * Exercises the real login listener and PGlite challenge store with delayed
 * callback work. The original HTTP redirect must survive beyond Bun's default
 * idle window, while a later replay still fails after one-time consumption.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { request } from "node:http";

test("delayed one-time callback returns its redirect without a socket retry", async () => {
  const environment = {
    NODE_ENV: "test",
    STEWARD_RUNTIME: "bun",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    REDIS_URL: "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
  };
  const previous = new Map(
    [...Object.keys(environment), "STEWARD_DB_MODE", "STEWARD_EMBEDDED"].map(
      (key) => [key, process.env[key]],
    ),
  );
  Object.assign(process.env, environment);
  const { authRoutes, getAuthChallengeStore } = await import(
    "../api/src/routes/auth"
  );
  const { startEmbeddedLogin } = await import("../runtime");
  const callbackPath = `/transport-callback-${randomBytes(8).toString("hex")}`;
  const stateKey = `callback-transport:${randomBytes(16).toString("hex")}`;
  let calls = 0;
  let callbackFinished: Promise<void> | undefined;
  authRoutes.get(callbackPath, async (c) => {
    calls += 1;
    if (!(await getAuthChallengeStore().consume(stateKey))) {
      return c.json({ error: "state_consumed" }, 401);
    }
    callbackFinished = Bun.sleep(22_000);
    await callbackFinished;
    return c.redirect("/completed-callback", 302);
  });
  let server: Awaited<ReturnType<typeof startEmbeddedLogin>> | undefined;
  try {
    server = await startEmbeddedLogin({ port: 0 });
    await getAuthChallengeStore().set(stateKey, "one-time-test-state");
    const url = `http://127.0.0.1:${server.port}/auth${callbackPath}`;
    // Node's HTTP client sends exactly once; automatic proxy/fetch retries
    // would conceal a dropped first response with the replay's 401.
    const response = await new Promise<{
      status: number | undefined;
      location: string | undefined;
    }>((resolve, reject) => {
      const req = request(url, { agent: false }, (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode, location: res.headers.location }),
        );
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    expect(response).toEqual({ status: 302, location: "/completed-callback" });
    expect(calls).toBe(1);
    const replay = await fetch(url, { redirect: "manual" });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "state_consumed" });
    expect(calls).toBe(2);
  } finally {
    await callbackFinished;
    await server?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 40_000);
