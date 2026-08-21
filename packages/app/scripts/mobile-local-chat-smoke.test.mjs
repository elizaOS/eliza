/**
 * Exercises the mobile smoke CLI's host-side protocol, parsing, retry, and filesystem boundaries.
 * Also covers fail-closed numeric env overrides so a typo cannot become a 1 ms
 * timer or skip the AbortController timeout gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fakeDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "eliza-mobile-tools-"),
);
let fakeDefaultsState;
let fakeIosDataContainer;
let fakeAndroidContext;

process.env.ANDROID_STABILITY_SAMPLES = "2";
process.env.ANDROID_STABILITY_ATTEMPTS = "3";
process.env.ANDROID_STABILITY_DELAY_MS = "0";
process.env.ANDROID_LOCAL_INFERENCE_READY_ATTEMPTS = "3";
process.env.ANDROID_LOCAL_INFERENCE_READY_DELAY_MS = "0";
process.env.ANDROID_TRANSIENT_RETRY_ATTEMPTS = "2";
process.env.ANDROID_TRANSIENT_RETRY_DELAY_MS = "0";
process.env.ANDROID_HEALTH_PROBE_TIMEOUT_MS = "50";
process.env.ANDROID_SMOKE_MODEL_SIZE_BYTES = "4";

const originalArgv = process.argv;
const originalPath = process.env.PATH;
const originalCommandProxy = process.env.ELIZA_SMOKE_COMMAND_PROXY;
process.env.PATH = `${fakeDirectory}:${originalPath}`;
process.env.ELIZA_SMOKE_COMMAND_PROXY = path.resolve(
  import.meta.dirname,
  "../test/fixtures/mobile-command-proxy.cjs",
);
process.argv = [
  "bun",
  "mobile-local-chat-smoke.test.mjs",
  "--platform",
  "unit-test",
];
const smoke = await import("./mobile-local-chat-smoke.mjs");
process.argv = originalArgv;

let server;
let baseUrl;
let uptime = 0;
let conversationCount = 0;
const requests = [];

function json(value, init = {}) {
  return Response.json(value, init);
}

function validIosFullBunResult() {
  return {
    ok: true,
    phase: "complete",
    updatedAt: new Date().toISOString(),
    runtimeStatus: { ready: true, engine: "bun" },
    bridgeStatus: {
      ready: true,
      engine: "bun",
      transport: "bun-host-ipc",
    },
    directHealth: { ready: true, runtime: "ok" },
    fetchHealth: { ready: true, runtime: "ok" },
    localInference: {
      hub: {
        catalog: [],
        installed: [{ id: "eliza-1-2b" }],
        active: {},
        assignments: {},
      },
      device: {
        enabled: true,
        connected: true,
        transport: "bun-host-ipc",
        devices: [],
      },
      providers: {
        providers: [
          {
            id: "capacitor-llama",
            registeredSlots: ["TEXT_SMALL", "TEXT_LARGE"],
          },
        ],
      },
      installed: { models: [{ id: "eliza-1-2b" }] },
      activatedModel: { status: "ready", modelPath: "/models/model.gguf" },
      active: { status: "ready" },
      routing: { registrations: [], preferences: {} },
    },
    conversationId: "ios-conversation",
    modelInput: {
      text: "In one short sentence, confirm the iOS full Bun local backend is running.",
      channelType: "DM",
      source: "ios-local",
    },
    sendMessage: { text: "The iOS full Bun local backend is running." },
    streamMessage:
      'data: {"type":"done","text":"The iOS full Bun local backend is running."}\n\n',
  };
}

beforeAll(() => {
  fakeDefaultsState = path.join(fakeDirectory, "defaults.json");
  fakeIosDataContainer = path.join(fakeDirectory, "ios-data");
  const fakeIosAppContainer = path.join(fakeDirectory, "App.app");
  const fakeModel = path.join(fakeDirectory, "model.gguf");
  const fakeAndroidHome = path.join(fakeDirectory, "android-sdk");
  const fakeAdb = path.join(fakeAndroidHome, "platform-tools", "adb");
  fs.mkdirSync(fakeIosAppContainer, { recursive: true });
  fs.mkdirSync(fakeIosDataContainer, { recursive: true });
  fs.mkdirSync(path.dirname(fakeAdb), { recursive: true });
  fs.writeFileSync(fakeAdb, "");
  fs.writeFileSync(fakeDefaultsState, "{}\n");
  fs.writeFileSync(fakeModel, "gguf");

  process.env.FAKE_DEFAULTS_STATE = fakeDefaultsState;
  process.env.FAKE_IOS_DATA_CONTAINER = fakeIosDataContainer;
  process.env.FAKE_IOS_APP_CONTAINER = fakeIosAppContainer;
  process.env.ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH = fakeModel;
  process.env.ANDROID_SMOKE_MODEL_PATH = fakeModel;
  process.env.ANDROID_HOME = fakeAndroidHome;
  process.env.PATH = `${fakeDirectory}:${originalPath}`;
  fakeAndroidContext = {
    adb: fakeAdb,
    serial: "emulator-unit",
    installed: true,
  };

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.text() : "";
      requests.push({
        method: request.method,
        pathname: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      });

      if (url.pathname === "/api/health") {
        uptime += 1;
        return json({
          ready: true,
          agentState: "running",
          uptime,
          startup: { attempt: 1 },
        });
      }
      if (url.pathname === "/api/local-inference/hub") {
        return new Response("missing", { status: 404 });
      }
      if (url.pathname === "/api/local-inference/device") {
        return json({ connected: false, devices: [] });
      }
      if (url.pathname === "/api/local-inference/providers") {
        return json({
          providers: [{ id: "capacitor-llama", servingVia: "bionic-host" }],
        });
      }
      if (url.pathname === "/api/conversations") {
        conversationCount += 1;
        return json({
          conversation: { id: `conversation-${conversationCount}` },
        });
      }
      if (url.pathname.endsWith("/greeting")) {
        return json({ text: "Hello from the local agent" });
      }
      if (url.pathname.endsWith("/messages/stream")) {
        return new Response(
          'event: message\ndata: {"type":"done","fullText":"android smoke model works.","usage":{"model":"eliza-1-2b","provider":"capacitor-llama"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname === "/raw") {
        return new Response("not-json");
      }
      if (url.pathname === "/missing") {
        return new Response("missing", { status: 404 });
      }
      if (url.pathname === "/failure") {
        return new Response("failed", { status: 503 });
      }
      if (url.pathname === "/slow") {
        await Bun.sleep(30);
        return json({ ok: true });
      }
      return json({ ok: true, body });
    },
  });
  baseUrl = server.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  server.stop(true);
  process.env.PATH = originalPath;
  if (originalCommandProxy === undefined) {
    delete process.env.ELIZA_SMOKE_COMMAND_PROXY;
  } else {
    process.env.ELIZA_SMOKE_COMMAND_PROXY = originalCommandProxy;
  }
  fs.rmSync(fakeDirectory, { recursive: true, force: true });
});

describe("mobile smoke filesystem and encoding helpers", () => {
  it("escapes XML/shell input and reports model sizes", () => {
    expect(smoke.xmlEscape(`<tag a="x" b='y'>&`)).toBe(
      "&lt;tag a=&quot;x&quot; b=&apos;y&apos;&gt;&amp;",
    );
    expect(smoke.shellQuote("it's ready")).toBe("'it'\\''s ready'");
    expect(smoke.describeAndroidSmokeModelSize(42)).toBe("42 bytes");
    expect(smoke.describeAndroidSmokeModelSize(Number.NaN)).toBe(
      "unknown size",
    );
    expect(smoke.appId()).toBe("ai.elizaos.app");
  });

  it("copies only changed files and exposes explicit missing-file signals", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-smoke-unit-"),
    );
    const source = path.join(directory, "source.txt");
    const destination = path.join(directory, "nested", "destination.txt");
    fs.writeFileSync(source, "one");
    expect(smoke.copyFileIfChanged(source, destination)).toBe(true);
    expect(smoke.copyFileIfChanged(source, destination)).toBe(false);
    fs.writeFileSync(source, "longer");
    expect(smoke.copyFileIfChanged(source, destination)).toBe(true);
    expect(smoke.readTextFileIfPresent(destination)).toBe("longer");
    expect(smoke.readTextFileIfPresent(path.join(directory, "missing"))).toBe(
      "",
    );
    expect(
      await smoke.verifySmokeModelFile(path.join(directory, "missing")),
    ).toBe(false);
    expect(await smoke.verifySmokeModelFile(destination)).toBe(false);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("mobile smoke native command boundaries", () => {
  it("seeds, stages, reads, and verifies the iOS full-Bun handshake through simulator defaults", async () => {
    const launched = smoke.launchIosSimulatorApp();
    expect(launched).toMatchObject({
      udid: "11111111-1111-1111-1111-111111111111",
      installed: true,
    });

    smoke.preseedIosLocalRuntime(launched.udid, "ai.elizaos.app");
    smoke.stageIosFullBunSmokeModel(launched.udid, "ai.elizaos.app");
    smoke.stageIosFullBunSmokeModel(launched.udid, "ai.elizaos.app");
    smoke.preseedIosFullBunSmoke(launched.udid, "ai.elizaos.app");

    const seeded = JSON.parse(fs.readFileSync(fakeDefaultsState, "utf8"));
    expect(seeded["CapacitorStorage.eliza:ios-full-bun-smoke:request"]).toBe(
      "1",
    );
    expect(seeded["eliza:ios-full-bun-smoke:request"]).toBe("1");
    expect(smoke.iosAppSupportContainer(launched.udid, "ai.elizaos.app")).toBe(
      path.join(
        fakeIosDataContainer,
        "Library",
        "Application Support",
        "Eliza",
      ),
    );

    const result = validIosFullBunResult();
    seeded["CapacitorStorage.eliza:ios-full-bun-smoke:result"] =
      JSON.stringify(result);
    fs.writeFileSync(fakeDefaultsState, JSON.stringify(seeded));
    const verified = await smoke.verifyIosFullBunSmoke({
      ...launched,
      fullBunSmokeRequestedAtMs: Date.now() - 500,
    });
    expect(verified.conversationId).toBe("ios-conversation");
    const evidenceDirectory = path.join(fakeDirectory, "ios-evidence");
    const evidencePath = smoke.writeIosFullBunSmokeResultEvidence(
      verified,
      evidenceDirectory,
    );
    expect(JSON.parse(fs.readFileSync(evidencePath, "utf8"))).toEqual(verified);
    expect(smoke.writeIosFullBunSmokeResultEvidence(verified, "")).toBeNull();
    expect(
      smoke.readIosFullBunSmokeDiagnostics(launched.udid, "ai.elizaos.app")
        .keys["eliza:ios-full-bun-smoke:result"].defaultsValue,
    ).toBe(JSON.stringify(result));
    const screenshot = smoke.takeIosScreenshot(launched.udid, "unit");
    expect(fs.readFileSync(screenshot, "utf8")).toBe("screenshot");
    expect(await smoke.verifyIosFullBunSmoke({ installed: false })).toBeNull();
  }, 60_000);

  it("drives Android package, preference, registry, model, and cleanup commands", async () => {
    expect(smoke.androidDeviceSerial(fakeAndroidContext.adb)).toBe(
      "emulator-unit",
    );
    const launched = await smoke.launchAndroidEmulatorApp();
    expect(launched).toMatchObject({
      serial: "emulator-unit",
      installed: true,
    });
    smoke.writeAndroidCapacitorPreferences(fakeAndroidContext, {
      "unsafe<&key": "value\"'",
    });
    smoke.preseedAndroidLocalRuntime(fakeAndroidContext);
    smoke.forceStopConflictingAndroidAgents(fakeAndroidContext);
    smoke.removeAndroidReverse(fakeAndroidContext, 31337);
    await smoke.stageAndroidSmokeModel(fakeAndroidContext);
    smoke.writeAndroidSmokeModelManifest(
      fakeAndroidContext,
      "files/.eliza/local-inference/models",
    );
    smoke.writeAndroidLocalInferenceRegistry(
      fakeAndroidContext,
      "files/.eliza/local-inference",
    );
    expect(smoke.readAndroidLocalAgentToken(fakeAndroidContext)).toBe(
      "unit-token",
    );
    expect(smoke.androidRunAs(fakeAndroidContext, "echo ready", "failed")).toBe(
      "",
    );
    const contextWithForward = {
      ...fakeAndroidContext,
      localAgentForward: "tcp:42000",
    };
    smoke.cleanupAndroidAgentForwards(contextWithForward, "unit");
    expect(contextWithForward.localAgentForward).toBeNull();
    expect(smoke.dumpAndroidUiHierarchy(fakeAndroidContext, "unit")).toContain(
      "unit-",
    );
  }, 60_000);
});

describe("mobile smoke result parsing", () => {
  it("normalizes wake timestamps and startup attempts", () => {
    expect(smoke.readLastWakeFiredAtMs(null)).toBeNull();
    expect(smoke.readLastWakeFiredAtMs({ lastWakeFiredAt: 123 })).toBe(123);
    expect(
      smoke.readLastWakeFiredAtMs({
        lastWakeFiredAt: "2026-07-13T12:00:00.000Z",
      }),
    ).toBe(Date.parse("2026-07-13T12:00:00.000Z"));
    expect(
      smoke.readLastWakeFiredAtMs({ lastWakeFiredAt: "invalid" }),
    ).toBeNull();
    expect(smoke.readLastWakeFiredAtMs({ lastWakeFiredAt: {} })).toBeNull();
    expect(smoke.readStartupAttempt({ startup: { attempt: 2 } })).toBe(2);
    expect(smoke.readStartupAttempt({ startup: { attempt: "2" } })).toBeNull();
  });

  it("parses comments, event names, JSON, multiline data, and raw SSE", () => {
    const events = smoke.parseSseEvents(
      ':keepalive\r\nevent: message\r\ndata: {"type":"content"}\r\n\r\n' +
        "event: raw\ndata: first\ndata: second\n\nignored\n\n",
    );
    expect(events).toEqual([
      {
        event: "message",
        data: { type: "content" },
        dataText: '{"type":"content"}',
      },
      { event: "raw", data: "first\nsecond", dataText: "first\nsecond" },
    ]);
  });

  it("extracts a done event and rejects error/missing events", () => {
    const done = smoke.extractDoneEventFromSse(
      'data: {"type":"done","fullText":"android smoke model works"}\n\n',
    );
    expect(done.type).toBe("done");
    expect(() =>
      smoke.extractDoneEventFromSse(
        'data: {"type":"error","message":"boom"}\n\n',
      ),
    ).toThrow(/Stream returned error event/);
    expect(() => smoke.extractDoneEventFromSse("data: {}\n\n")).toThrow(
      /did not return a done event/,
    );
  });

  it("requires an exact useful full-turn reply", () => {
    expect(
      smoke.requireUsableFullTurnReply(
        { fullText: '"Android smoke model works!"' },
        "stream",
      ),
    ).toBe('"Android smoke model works!"');
    for (const [done, expected] of [
      [null, /was not an object/],
      [{ failureKind: "model_error" }, /failureKind/],
      [{ noResponseReason: "muted" }, /noResponseReason/],
      [{ text: "" }, /empty reply/],
      [{ text: "Chat generation failed" }, /unusable reply/],
      [{ text: "wrong reply" }, /wrong reply/],
    ]) {
      expect(() => smoke.requireUsableFullTurnReply(done, "stream")).toThrow(
        expected,
      );
    }
  });

  it("summarizes optional local-inference payloads without inventing readiness", () => {
    expect(
      smoke.localInferenceSummary({ hub: null, device: null, providers: null }),
    ).toEqual({
      hubActive: null,
      hubDownloads: [],
      device: null,
      providers: [],
    });
    expect(
      smoke.localInferenceSummary({
        hub: { active: { status: "ready" }, downloads: ["model"] },
        device: { connected: true },
        providers: { providers: [{ id: "capacitor-llama" }] },
      }),
    ).toEqual({
      hubActive: { status: "ready" },
      hubDownloads: ["model"],
      device: { connected: true },
      providers: [{ id: "capacitor-llama" }],
    });
  });
});

describe("mobile smoke HTTP and retry boundary", () => {
  it("round-trips JSON, auth, raw bodies, optional 404s, and hard failures", async () => {
    const result = await smoke.requestJson(
      "POST",
      "/echo",
      { value: 1 },
      `${baseUrl}/`,
      " token ",
    );
    expect(result).toEqual({ ok: true, body: '{"value":1}' });
    expect(requests.at(-1).authorization).toBe("Bearer token");
    expect(requests.at(-1).body).toBe('{"value":1}');

    const raw = await smoke.requestJsonResponse(
      "GET",
      "/raw",
      undefined,
      baseUrl,
      null,
    );
    expect(raw.data).toEqual({ raw: "not-json" });
    expect(
      await smoke.requestOptionalJson("GET", "/missing", baseUrl),
    ).toBeNull();
    await expect(
      smoke.requestOptionalJson("GET", "/failure", baseUrl),
    ).rejects.toThrow(/503 failed/);
    await expect(
      smoke.requestJson("GET", "/failure", undefined, baseUrl),
    ).rejects.toThrow(/503 failed/);
    await expect(
      smoke.requestTextResponse("GET", "/failure", undefined, baseUrl),
    ).rejects.toThrow(/503 failed/);
  });

  it("turns an aborted request into an observable timeout", async () => {
    await expect(
      smoke.requestJsonResponse("GET", "/slow", undefined, baseUrl, null, {
        timeoutMs: 2,
      }),
    ).rejects.toThrow(/timed out after 2ms/);
  });

  it("retries transient failures only", async () => {
    expect(smoke.isTransientFailure(new Error("ECONNRESET"))).toBe(true);
    expect(smoke.isTransientFailure(new Error("bad request"))).toBe(false);
    expect(smoke.isTransientFailure("ECONNRESET")).toBe(false);
    let attempts = 0;
    const value = await smoke.withTransientRetry(
      "unit",
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket hang up");
        return "ok";
      },
      { attempts: 2, delayMs: 0 },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(2);
    await expect(
      smoke.withTransientRetry(
        "unit",
        async () => {
          throw new Error("assertion mismatch");
        },
        { attempts: 2, delayMs: 0 },
      ),
    ).rejects.toThrow(/assertion mismatch/);
  });

  it("proves the complete local-inference API turn against a real HTTP server", async () => {
    uptime = 0;
    conversationCount = 0;
    await smoke.runLocalInferenceApiSmoke(baseUrl, "secret");
    expect(
      requests.some(({ pathname }) => pathname.endsWith("/messages/stream")),
    ).toBe(true);
  });
});

describe("mobile smoke failure states", () => {
  it("rejects an unstable process and a local-inference error", async () => {
    const unstable = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/health") {
          return json({ ready: false, agentState: "starting", uptime: null });
        }
        if (url.pathname === "/api/local-inference/hub") {
          return json({ active: { status: "error", error: "model failed" } });
        }
        return new Response("missing", { status: 404 });
      },
    });
    const unstableBase = unstable.url.toString().replace(/\/$/, "");
    await expect(
      smoke.waitForAndroidProcessStability(unstableBase),
    ).rejects.toThrow(/did not reach 2 consecutive/);
    await expect(
      smoke.requireLocalInferenceReady(unstableBase),
    ).rejects.toThrow(/model failed/);
    unstable.stop(true);
  });

  it("reports absent simulator defaults without fabricating values", async () => {
    fs.writeFileSync(fakeDefaultsState, "{}\n");
    const diagnostics = smoke.readIosFullBunSmokeDiagnostics(
      "NO-SIMULATOR",
      "ai.elizaos.app",
    );
    expect(diagnostics.plistExists).toBe(false);
    expect(
      diagnostics.keys["eliza:ios-full-bun-smoke:request"].defaultsValue,
    ).toBeNull();
    await smoke.main();
  });
});

const SMOKE_SCRIPT = fileURLToPath(
  new URL("./mobile-local-chat-smoke.mjs", import.meta.url),
);

function runSmokeCli(envOverrides) {
  return spawnSync(process.execPath, [SMOKE_SCRIPT, "--platform", "skip"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...envOverrides,
    },
    timeout: 8_000,
  });
}

describe("resolveMobileSmokeNumericEnv", () => {
  it("keeps every documented default when knobs are unset or empty", () => {
    expect(smoke.resolveMobileSmokeNumericEnv({})).toEqual({
      iosFullBunSmokeContextSize: smoke.DEFAULT_IOS_FULL_BUN_SMOKE_CONTEXT_SIZE,
      androidFullTurnTimeoutMs: smoke.DEFAULT_ANDROID_FULL_TURN_TIMEOUT_MS,
      androidHealthProbeTimeoutMs:
        smoke.DEFAULT_ANDROID_HEALTH_PROBE_TIMEOUT_MS,
      androidTransientRetryAttempts:
        smoke.DEFAULT_ANDROID_TRANSIENT_RETRY_ATTEMPTS,
      androidTransientRetryDelayMs:
        smoke.DEFAULT_ANDROID_TRANSIENT_RETRY_DELAY_MS,
      androidStabilitySamples: smoke.DEFAULT_ANDROID_STABILITY_SAMPLES,
      androidStabilityDelayMs: smoke.DEFAULT_ANDROID_STABILITY_DELAY_MS,
      androidStabilityAttempts: smoke.DEFAULT_ANDROID_STABILITY_ATTEMPTS,
      androidLocalInferenceReadyAttempts:
        smoke.DEFAULT_ANDROID_LOCAL_INFERENCE_READY_ATTEMPTS,
      androidLocalInferenceReadyDelayMs:
        smoke.DEFAULT_ANDROID_LOCAL_INFERENCE_READY_DELAY_MS,
      androidSmokeModelContextSize:
        smoke.DEFAULT_ANDROID_SMOKE_MODEL_CONTEXT_SIZE,
      androidSmokeModelSizeBytesOverride: null,
    });
    expect(
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_FULL_TURN_TIMEOUT_MS: "",
        ANDROID_HEALTH_PROBE_TIMEOUT_MS: "   ",
      }).androidFullTurnTimeoutMs,
    ).toBe(smoke.DEFAULT_ANDROID_FULL_TURN_TIMEOUT_MS);
  });

  it("accepts canonical timer and count overrides through the Node ceiling", () => {
    const parsed = smoke.resolveMobileSmokeNumericEnv({
      ANDROID_FULL_TURN_TIMEOUT_MS: "800",
      ANDROID_HEALTH_PROBE_TIMEOUT_MS: "60000",
      ANDROID_TRANSIENT_RETRY_ATTEMPTS: "1",
      ANDROID_STABILITY_DELAY_MS: "0",
      ANDROID_SMOKE_MODEL_CONTEXT_SIZE: "4096",
      ANDROID_SMOKE_MODEL_SIZE_BYTES: "4",
    });
    expect(parsed.androidFullTurnTimeoutMs).toBe(800);
    expect(parsed.androidHealthProbeTimeoutMs).toBe(60000);
    expect(parsed.androidTransientRetryAttempts).toBe(1);
    expect(parsed.androidStabilityDelayMs).toBe(0);
    expect(parsed.androidSmokeModelContextSize).toBe(4096);
    expect(parsed.androidSmokeModelSizeBytesOverride).toBe(4);
  });

  it("rejects scientific notation, partial tokens, and timer overflow", () => {
    for (const value of [
      "1e3",
      "8abc",
      "0x10",
      "0.4",
      "abc",
      "-1",
      "0",
      String(smoke.MAX_TIMER_DELAY_MS + 1),
    ]) {
      expect(() =>
        smoke.resolveMobileSmokeNumericEnv({
          ANDROID_FULL_TURN_TIMEOUT_MS: value,
        }),
      ).toThrow(/ANDROID_FULL_TURN_TIMEOUT_MS/);
    }
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_HEALTH_PROBE_TIMEOUT_MS: "abc",
      }),
    ).toThrow(/ANDROID_HEALTH_PROBE_TIMEOUT_MS/);
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_TRANSIENT_RETRY_ATTEMPTS: "1e3",
      }),
    ).toThrow(/ANDROID_TRANSIENT_RETRY_ATTEMPTS/);
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_SMOKE_MODEL_CONTEXT_SIZE: "8abc",
      }),
    ).toThrow(/ANDROID_SMOKE_MODEL_CONTEXT_SIZE/);
  });

  it("rejects leading-zero spellings the shared helpers would accept", () => {
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_TRANSIENT_RETRY_ATTEMPTS: "0008",
      }),
    ).toThrow(/ANDROID_TRANSIENT_RETRY_ATTEMPTS.*leading zeros/);
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({ ANDROID_STABILITY_DELAY_MS: "00" }),
    ).toThrow(/ANDROID_STABILITY_DELAY_MS.*leading zeros/);
    expect(
      smoke.resolveMobileSmokeNumericEnv({ ANDROID_STABILITY_DELAY_MS: "0" })
        .androidStabilityDelayMs,
    ).toBe(0);
  });

  it("bounds context sizes at the operational cap, rejecting the known-OOM full width", () => {
    for (const name of [
      "IOS_FULL_BUN_SMOKE_CONTEXT_SIZE",
      "ANDROID_SMOKE_MODEL_CONTEXT_SIZE",
    ]) {
      expect(
        smoke.resolveMobileSmokeNumericEnv({
          [name]: String(smoke.MAX_MODEL_CONTEXT_TOKENS),
        }),
      ).toBeTruthy();
      // 131072 is the model's format ceiling AND the documented phone OOM
      // width — it must be a rejection case, not the bound.
      for (const value of [
        String(smoke.MAX_MODEL_CONTEXT_TOKENS + 1),
        "131072",
        String(Number.MAX_SAFE_INTEGER),
      ]) {
        expect(() =>
          smoke.resolveMobileSmokeNumericEnv({ [name]: value }),
        ).toThrow(new RegExp(name));
      }
    }
  });

  it("bounds count knobs at the operational loop maximum", () => {
    for (const name of [
      "ANDROID_TRANSIENT_RETRY_ATTEMPTS",
      "ANDROID_STABILITY_SAMPLES",
      "ANDROID_STABILITY_ATTEMPTS",
      "ANDROID_LOCAL_INFERENCE_READY_ATTEMPTS",
    ]) {
      for (const value of [
        String(smoke.MAX_LOOP_COUNT + 1),
        String(Number.MAX_SAFE_INTEGER),
      ]) {
        expect(() =>
          smoke.resolveMobileSmokeNumericEnv({ [name]: value }),
        ).toThrow(new RegExp(name));
      }
    }
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_SMOKE_MODEL_SIZE_BYTES: String(smoke.MAX_MODEL_SIZE_BYTES + 1),
      }),
    ).toThrow(/ANDROID_SMOKE_MODEL_SIZE_BYTES/);
  });

  it("budgets count per-attempt work, not only delay (review counterexamples)", () => {
    // 10000 attempts at delay 0 with a max probe timeout asserted a zero
    // delay-budget but could consume ~680 years of probe work.
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_TRANSIENT_RETRY_ATTEMPTS: String(smoke.MAX_LOOP_COUNT),
        ANDROID_TRANSIENT_RETRY_DELAY_MS: "0",
        ANDROID_HEALTH_PROBE_TIMEOUT_MS: String(smoke.MAX_TIMER_DELAY_MS),
      }),
    ).toThrow(/loop budget/);
    // A max probe or full-turn timeout alone now exceeds the composite
    // stability/retry budgets at the documented default attempt counts.
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_HEALTH_PROBE_TIMEOUT_MS: String(smoke.MAX_TIMER_DELAY_MS),
      }),
    ).toThrow(/loop budget/);
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_FULL_TURN_TIMEOUT_MS: String(smoke.MAX_TIMER_DELAY_MS),
      }),
    ).toThrow(/loop budget/);
  });

  it("rejects over-budget loop combinations and inconsistent stability windows", () => {
    // 10_000 attempts × 8_640_001ms ≈ 2.7 years — each value alone is legal.
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_LOCAL_INFERENCE_READY_ATTEMPTS: String(smoke.MAX_LOOP_COUNT),
        ANDROID_LOCAL_INFERENCE_READY_DELAY_MS: "8640001",
      }),
    ).toThrow(/loop budget/);
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_TRANSIENT_RETRY_ATTEMPTS: "100",
        ANDROID_TRANSIENT_RETRY_DELAY_MS: "864001",
      }),
    ).toThrow(/ANDROID_TRANSIENT_RETRY_ATTEMPTS.*loop budget/s);
    expect(() =>
      smoke.resolveMobileSmokeNumericEnv({
        ANDROID_STABILITY_SAMPLES: "10",
        ANDROID_STABILITY_ATTEMPTS: "5",
      }),
    ).toThrow(/ANDROID_STABILITY_SAMPLES.*exceeds ANDROID_STABILITY_ATTEMPTS/);
    // The documented defaults stay well inside every budget.
    expect(smoke.resolveMobileSmokeNumericEnv({})).toBeTruthy();
  });
});

describe("readiness request timeout boundary", () => {
  it("a never-settling readiness fetch rejects within the probe timeout", async () => {
    // requestOptionalJson used to issue an un-timed fetch, so one hung
    // readiness endpoint outlived any loop budget. Harness probe timeout is
    // 50ms (module preamble), so the hang must reject fast.
    const hang = Bun.serve({
      port: 0,
      fetch: () => new Promise(() => {}),
    });
    try {
      const startedAt = Date.now();
      await expect(
        smoke.requestOptionalJson(
          "GET",
          "/api/local-inference/hub",
          `http://127.0.0.1:${hang.port}`,
        ),
      ).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      hang.stop(true);
    }
  });
});

describe("mobile smoke numeric env CLI boundary", () => {
  it("rejects ANDROID_FULL_TURN_TIMEOUT_MS=1e3 before device or API work", () => {
    const result = runSmokeCli({ ANDROID_FULL_TURN_TIMEOUT_MS: "1e3" });
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toMatch(/ANDROID_FULL_TURN_TIMEOUT_MS/);
    expect(combined).not.toContain("timed out after 1ms");
    expect(combined).not.toContain("TimeoutOverflowWarning");
    expect(combined).not.toContain("[local-chat-smoke]");
  });

  it("rejects overflowing and partial timeout tokens before spawn work", () => {
    for (const value of ["8abc", "2147483648", "0.4"]) {
      const result = runSmokeCli({ ANDROID_FULL_TURN_TIMEOUT_MS: value });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(/ANDROID_FULL_TURN_TIMEOUT_MS/);
      expect(combined).not.toContain("TimeoutOverflowWarning");
      expect(combined).not.toContain("[local-chat-smoke]");
    }
  });

  it("rejects ANDROID_HEALTH_PROBE_TIMEOUT_MS=abc instead of hanging without a timer", () => {
    const result = runSmokeCli({ ANDROID_HEALTH_PROBE_TIMEOUT_MS: "abc" });
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toMatch(/ANDROID_HEALTH_PROBE_TIMEOUT_MS/);
    expect(combined).not.toContain("[local-chat-smoke]");
  });
});
