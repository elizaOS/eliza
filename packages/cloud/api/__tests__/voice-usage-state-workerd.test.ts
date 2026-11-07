import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

describe("Cloudflare voice quota accounting", () => {
  let worker: Miniflare;
  let directory: string;
  let script: string;
  let compatibilityDate: string;
  let compatibilityFlags: string[];
  const start = (binding = true, backend = "cloudflare") =>
    new Miniflare({
      compatibilityDate,
      compatibilityFlags,
      modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
      bindings: {
        CLOUD_VOICE_USAGE_BACKEND: backend,
        CLOUD_AUTH_STATE_BACKEND: "cloudflare",
        NODE_ENV: "production",
        MOCK_REDIS: "1",
        VOICE_REALTIME_WS_ENABLED: "true",
        CARTESIA_API_KEY: "synthetic-unused-key",
        VOICE_REALTIME_CARTESIA_VOICE_ID: "synthetic-unused-voice",
        VOICE_REALTIME_ELIZA_ENDPOINT: "https://unused.test",
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "synthetic-unused-auth",
        TWILIO_AUTH_TOKEN: "synthetic-unused-twilio",
      },
      durableObjects: {
        AUTHENTICATION_STATE: {
          className: "AuthenticationState",
          useSQLite: true,
        },
        ...(binding
          ? {
              VOICE_USAGE_STATE: {
                className: "VoiceUsageState",
                useSQLite: true,
              },
            }
          : {}),
      },
      durableObjectsPersist: directory,
      outboundService: () => {
        throw new Error("Unexpected external I/O in voice quota test");
      },
    });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "eliza-voice-usage-"));
    const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
    const source = Bun.TOML.parse(
      await readFile(join(apiDirectory, "wrangler.toml"), "utf8"),
    ) as {
      compatibility_date: string;
      compatibility_flags: string[];
      alias: Record<string, string>;
      define: Record<string, string>;
      env: { production: { compatibility_flags?: string[] } };
    };
    compatibilityDate = source.compatibility_date;
    compatibilityFlags =
      source.env.production.compatibility_flags ?? source.compatibility_flags;
    const configPath = join(directory, "wrangler.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        name: "voice-usage-test",
        main: join(apiDirectory, "test/fixtures/voice-usage-state-worker.ts"),
        tsconfig: relative(directory, join(apiDirectory, "tsconfig.json")),
        minify: true,
        compatibility_date: compatibilityDate,
        compatibility_flags: compatibilityFlags,
        define: source.define,
        alias: Object.fromEntries(
          Object.entries(source.alias).map(([name, target]) => [
            name,
            target.startsWith(".") ? resolve(apiDirectory, target) : target,
          ]),
        ),
      }),
    );
    const build = Bun.spawn(
      [
        process.execPath,
        "x",
        "--no-install",
        "wrangler",
        "deploy",
        join(apiDirectory, "test/fixtures/voice-usage-state-worker.ts"),
        "--dry-run",
        "--config",
        configPath,
        "--outdir",
        join(directory, "build"),
      ],
      { cwd: apiDirectory, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
      new Response(build.stdout).text(),
    ]);
    if (exitCode !== 0)
      throw new Error(`Voice fixture build failed: ${stderr}`);
    script = await readFile(
      join(directory, "build/voice-usage-state-worker.js"),
      "utf8",
    );
    worker = start();
    await worker.ready;
  }, 120000);
  afterAll(async () => {
    await worker?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const call = (body: Record<string, unknown>) =>
    worker.dispatchFetch("https://voice.test/", {
      method: "POST",
      body: JSON.stringify(body),
    });
  const reserve = async (
    organizationId: string,
    userId: string,
    minutes = 1,
    now = Date.UTC(2026, 9, 22, 12),
    orgLimit = 3,
    userLimit = 2,
  ) => {
    const response = await call({
      operation: "reserve",
      identity: { organizationId, userId },
      minutes,
      now,
      limits: {
        organizationDailyMinutes: orgLimit,
        userDailyMinutes: userLimit,
      },
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      allowed: boolean;
      scope?: string;
      organizationUsedMinutes?: number;
      userUsedMinutes?: number;
      usedMinutes?: number;
      day: string;
    }>;
  };
  test("concurrent users cannot overspend the shared organization quota, including after restart", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reserve("org-concurrent", `user-${i}`),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => r.scope === "organization")).toHaveLength(9);
    await worker.dispose();
    worker = start();
    expect((await reserve("org-concurrent", "another-user")).allowed).toBe(
      false,
    );
    expect((await reserve("another-org", "another-user")).allowed).toBe(true);
  });
  test("user limits, rounding, releases and day rollover preserve accounting", async () => {
    expect((await reserve("org-user", "a", 1)).allowed).toBe(true);
    expect((await reserve("org-user", "a", 1)).allowed).toBe(true);
    expect((await reserve("org-user", "a", 1)).scope).toBe("user");
    const release = await call({
      operation: "release",
      identity: { organizationId: "org-user", userId: "a" },
      minutes: 0.5,
      now: Date.UTC(2026, 9, 22, 12),
    });
    expect(release.status).toBe(200);
    expect((await reserve("org-user", "a", 0.5)).userUsedMinutes).toBe(2);
    expect(
      (await reserve("org-user", "a", 1, Date.UTC(2026, 9, 23, 0)))
        .userUsedMinutes,
    ).toBe(1);
    expect(
      (await reserve("org-round", "a", 0.0000001)).organizationUsedMinutes,
    ).toBe(0.000001);
    expect(
      (await reserve("org-round", "a", 0.0000001)).organizationUsedMinutes,
    ).toBe(0.000002);
  });
  test("transfer retains scaled usage and rejects conflicting or post-activation snapshots", async () => {
    const orgKey = "voice-usage:2026-10-22:org:org-transfer";
    const entries = [
      { key: orgKey, value: 2_000_000, expiresAt: Date.now() + 60_000 },
      {
        key: "voice-usage:2026-10-22:user:org-transfer:a",
        value: 1_000_000,
        expiresAt: Date.now() + 60_000,
      },
    ];
    const payload = { operation: "import", orgKey, entries };
    expect((await call(payload)).status).toBe(200);
    expect((await call(payload)).status).toBe(200);
    const conflict = await call({
      ...payload,
      entries: [{ ...entries[0], value: 0 }, entries[1]],
    });
    expect(conflict.status).toBe(503);
    expect(((await conflict.json()) as { message: string }).message).toContain(
      "409",
    );
    const admitted = await reserve("org-transfer", "a");
    expect(admitted.organizationUsedMinutes).toBe(3);
    expect(admitted.userUsedMinutes).toBe(2);
    await worker.dispose();
    worker = start();
    expect((await reserve("org-transfer", "b")).allowed).toBe(false);
    const replay = await call(payload);
    expect(replay.status).toBe(503);
    expect(((await replay.json()) as { message: string }).message).toContain(
      "409",
    );
  });
  test("expired imported counters grant no stale usage and imports cannot cross organizations", async () => {
    const orgKey = "voice-usage:2026-10-22:org:expired";
    expect(
      (
        await call({
          operation: "import",
          orgKey,
          entries: [
            { key: orgKey, value: 3_000_000, expiresAt: Date.now() - 1 },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await reserve("expired", "a")).organizationUsedMinutes).toBe(1);
    const foreign = await call({
      operation: "import",
      orgKey: "voice-usage:2026-10-22:org:foreign",
      entries: [
        { key: orgKey, value: 3_000_000, expiresAt: Date.now() + 60_000 },
      ],
    });
    expect(foreign.status).toBe(503);
    expect(((await foreign.json()) as { message: string }).message).toContain(
      "400",
    );
  });
  test("missing selected binding fails even when local mock Redis is configured", async () => {
    await worker.dispose();
    worker = start(false);
    const response = await call({
      operation: "reserve",
      identity: { organizationId: "missing", userId: "a" },
      minutes: 1,
      limits: { organizationDailyMinutes: 3, userDailyMinutes: 2 },
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe(
      "VoiceUsageStateError",
    );
  });
  test("both production socket routes reject missing metering before upgrade", async () => {
    for (const path of ["/voice?sessionId=synthetic-session", "/twilio"]) {
      const response = await worker.dispatchFetch(`https://voice.test${path}`, {
        headers: { Upgrade: "websocket" },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "voice realtime metering unavailable",
      });
      expect(response.webSocket).toBeNull();
    }
  });
  test("production sockets cannot use the local Redis mock as quota authority", async () => {
    await worker.dispose();
    worker = start(false, "redis");
    for (const path of ["/voice?sessionId=synthetic-session", "/twilio"]) {
      const response = await worker.dispatchFetch(`https://voice.test${path}`, {
        headers: { Upgrade: "websocket" },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "voice realtime metering unavailable",
      });
      expect(response.webSocket).toBeNull();
    }
  });
});
