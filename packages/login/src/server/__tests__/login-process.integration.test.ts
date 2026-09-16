/** Verifies that the real login executable releases its listener, database and event-loop handles on SIGTERM. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

test("the login process exits cleanly after SIGTERM", async () => {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = reservation.port;
  await reservation.stop(true);
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=eliza-source",
      new URL("../embedded.ts", import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        STEWARD_RUNTIME: "bun",
        STEWARD_DB_MODE: "pglite",
        STEWARD_PGLITE_MEMORY: "true",
        STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
        STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
        STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
        STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
        REDIS_URL: "",
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const logs = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        if (ready) break;
      } catch {
        // error-policy:J4 connection refusal is expected before the listener opens.
        ready = false;
      }
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    child.kill("SIGTERM");
    const result = await Promise.race([
      child.exited,
      new Promise<string>((resolve) => {
        deadlineTimer = setTimeout(() => resolve("shutdown timed out"), 5_000);
      }),
    ]);
    expect(result).toBe(0);
  } finally {
    clearTimeout(deadlineTimer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await logs;
  }
}, 30_000);
