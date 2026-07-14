/**
 * Exercises the mobile smoke CLI's host-side protocol, parsing, retry, and filesystem boundaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
process.env.PATH = `${fakeDirectory}:${originalPath}`;
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
    updatedAt: new Date().toISOString(),
    runtimeStatus: { ready: true, engine: "bun" },
    bridgeStatus: {
      ready: true,
      engine: "bun",
      transport: "bun-host-ipc",
    },
    fetchHealth: { ready: true, runtime: "ok" },
    localInference: {
      hub: { installed: [{ id: "eliza-1-2b" }] },
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
    },
    conversationId: "ios-conversation",
    sendMessage: { text: "ios smoke model works" },
    streamMessage: 'data: {"type":"done","text":"ios smoke model works"}\n\n',
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
  fs.writeFileSync(fakeDefaultsState, "{}\n");
  fs.writeFileSync(fakeModel, "gguf");

  const fakeXcrun = path.join(fakeDirectory, "xcrun");
  fs.writeFileSync(
    fakeXcrun,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_DEFAULTS_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] !== "simctl") process.exit(2);
if (args[1] === "list") {
  process.stdout.write("    iPhone Unit (11111111-1111-1111-1111-111111111111) (Booted)\\n");
  process.exit(0);
}
if (args[1] === "get_app_container") {
  process.stdout.write(args[4] === "data" ? process.env.FAKE_IOS_DATA_CONTAINER : process.env.FAKE_IOS_APP_CONTAINER);
  process.exit(0);
}
if (args[1] === "spawn" && args[3] === "defaults") {
  const operation = args[4];
  const key = args[6];
  const state = load();
  if (operation === "export") {
    process.stdout.write(JSON.stringify(state));
    process.exit(0);
  }
  if (operation === "write") {
    state[key] = args[8];
    save(state);
    process.exit(0);
  }
  if (operation === "read") {
    if (!(key in state)) process.exit(1);
    process.stdout.write(String(state[key]));
    process.exit(0);
  }
  if (operation === "delete") {
    delete state[key];
    save(state);
    process.exit(0);
  }
}
if (args[1] === "io" && args[3] === "screenshot") {
  fs.writeFileSync(args[4], "screenshot");
}
process.exit(0);
`,
    { mode: 0o755 },
  );

  const fakePlutil = path.join(fakeDirectory, "plutil");
  fs.writeFileSync(
    fakePlutil,
    `#!/usr/bin/env node
const fs = require("node:fs");
const source = process.argv.at(-1);
process.stdout.write(source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8"));
`,
    { mode: 0o755 },
  );

  fs.writeFileSync(
    fakeAdb,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "devices") {
  process.stdout.write("List of devices attached\\nemulator-unit\\tdevice\\n");
} else if (args.includes("pm") && args.includes("path")) {
  process.stdout.write("package:/data/app/ai.elizaos.app/base.apk\\n");
} else if (args.includes("files/auth/local-agent-token")) {
  process.stdout.write("unit-token\\n");
} else if (args.includes("tcp:0")) {
  process.stdout.write("42000\\n");
}
`,
    { mode: 0o755 },
  );

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
    const probe = Bun.spawnSync(
      ["xcrun", "simctl", "list", "devices", "booted"],
      { env: process.env },
    );
    expect({
      exitCode: probe.exitCode,
      stdout: probe.stdout.toString(),
      stderr: probe.stderr.toString(),
    }).toEqual({
      exitCode: 0,
      stdout:
        "    iPhone Unit (11111111-1111-1111-1111-111111111111) (Booted)\n",
      stderr: "",
    });
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
  }, 15_000);

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
  });
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
