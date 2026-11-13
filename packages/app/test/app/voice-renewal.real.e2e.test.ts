// @vitest-environment node
/** Real browser capture -> app host -> production relay, with explicit zero-price provider ports. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { createCloudSpeechRelayPorts } from "@elizaos/host/voice/cloud-speech-relay-client";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, onTestFinished, test, vi } from "vitest";
import { testOutputPath } from "../../../scripts/lib/test-output";
import { resolveAuthorizedRouteRole } from "../../src/api/auth";
import { createSelfHostedVoice } from "../../src/api/self-hosted-voice";
import { authStoreForRuntime } from "../../src/services/auth-store";
import { createVoiceRenewalRelay } from "../fixtures/voice-renewal-relay";

const root = path.resolve(import.meta.dirname, "../../../..");

test("browser voice crosses a real paid window after one consent reset and retires on Stop", async () => {
  const cleanups: Array<() => unknown> = [];
  const dispose = async () => {
    const errors: unknown[] = [];
    while (cleanups.length) {
      try {
        await cleanups.pop()?.();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Voice walkthrough cleanup failed");
  };
  onTestFinished(dispose);
  cleanups.push(() => vi.unstubAllEnvs());
  const directory = await mkdtemp(
    path.join(tmpdir(), "voice-renewal-browser-"),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const output = testOutputPath("voice-renewal-browser");
  await mkdir(output, { recursive: true });
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_ENABLED", "1");
  vi.stubEnv("ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED", "1");
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "controlled-cloud-owner");
  vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://api-staging.eliza.app/api/v1");
  vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "");
  const agentId = randomUUID() as UUID,
    conversationId = randomUUID();
  const adapter = SQLiteDatabaseAdapter.create(
    path.join(directory, "agent.sqlite"),
    agentId,
  );
  cleanups.push(() => adapter.close());
  await adapter.initialize();
  const runtime = {
    agentId,
    adapter,
    reportError(error: unknown) {
      throw error;
    },
  } as unknown as AgentRuntime;
  const store = authStoreForRuntime(runtime);
  if (!store) throw Error("Missing browser evidence auth store");
  await store.createIdentity({
    id: "owner",
    kind: "owner",
    displayName: "Controlled owner",
    createdAt: Date.now(),
  });
  await store.createSession({
    id: "controlled-owner-session",
    identityId: "owner",
    kind: "machine",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + 3600000,
    rememberDevice: false,
    csrfSecret: "controlled-csrf",
    ip: null,
    userAgent: null,
    scopes: [],
  });
  const relay = await createVoiceRenewalRelay();
  cleanups.push(() => relay.close());
  let resets = 0,
    cloudConsentAttempts = 0,
    hostSockets = 0,
    replies = 0;
  const state = {
    current: runtime,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
  const host = createSelfHostedVoice(state, {
    createCloudSpeechPorts: (options) =>
      createCloudSpeechRelayPorts({
        ...options,
        origin: relay.origin,
        allowInsecureLoopback: true,
        fetch: Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (new URL(String(input)).pathname.endsWith("/consent")) {
              cloudConsentAttempts++;
              if (resets++ === 0)
                throw Object.assign(
                  Error("Controlled pre-admission connection reset"),
                  { code: "ECONNRESET" },
                );
            }
            return fetch(input, init);
          },
          { preconnect() {} },
        ) as typeof fetch,
      }),
  });
  cleanups.push(() => host.close());
  const entry = `import { createVoiceSessionClient } from ${JSON.stringify(path.join(root, "packages/ui/src/voice/voice-session-client-core.ts"))};
const facts = { captures: 0, sockets: 0, activeTracks: 0, mints: 0, errors: [], phases: [], transcript: '', replies: 0, playbackFrames: 0 };
const status = document.getElementById('status');
const display = () => { status.textContent = JSON.stringify(facts, null, 2); };
const send = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Authorization: 'Bearer controlled-owner-session' } });
const client = createVoiceSessionClient({ agentId: ${JSON.stringify(agentId)}, conversationId: ${JSON.stringify(conversationId)}, fetch: send, requireTurnTerminal: true,
  getConsentNonce: async () => (await (await send('/api/v1/voice/session/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).consentNonce,
  getUserMedia: async (constraints) => { const stream = await navigator.mediaDevices.getUserMedia(constraints); facts.captures++; for (const track of stream.getTracks()) { facts.activeTracks++; track.addEventListener('ended', () => { facts.activeTracks--; display(); }); const stop = track.stop.bind(track); track.stop = () => { if (track.readyState !== 'ended') facts.activeTracks--; stop(); display(); }; } display(); return stream; },
  webSocketFactory: (url) => { facts.sockets++; display(); return new WebSocket(url); },
  onMinted: () => { facts.mints++; display(); },
  onState: (state) => { facts.phase = state.phase; if (facts.phases.at(-1) !== state.phase) facts.phases.push(state.phase); if (state.finalTranscript) facts.transcript = state.finalTranscript; display(); },
  onServerEvent: (event) => { if (event.t === 'speaking_end') facts.replies++; display(); },
  onPlaybackStats: (event) => { facts.playbackFrames++; display(); },
  onError: (error) => { facts.errors.push(error.message); display(); }
});
document.getElementById('start').onclick = async () => { await client.start(); display(); };
document.getElementById('stop').onclick = async () => { await client.stop(); display(); };
window.voiceEvidence = { snapshot: () => ({ ...facts }), stop: () => client.stop() }; display();`;
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root, loader: "ts" },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    alias: {
      "@elizaos/host/voice/ui-context": path.join(
        root,
        "packages/host/src/voice/ui-context.ts",
      ),
    },
  });
  const script = bundle.outputFiles[0].text;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><meta name="viewport" content="width=device-width"><style>body{background:#111a2a;color:#f5f7fb;font:18px system-ui;padding:32px;max-width:900px;margin:auto}button{font:inherit;padding:12px 24px;margin:12px}pre{white-space:pre-wrap;background:#1c2940;padding:24px;border-radius:12px}</style><h1>Controlled voice renewal walkthrough</h1><p>Production browser client, local host and relay. Synthetic microphone and provider audio. Zero-price provider receipts. This is not a production service test.</p><button id="start">Start voice</button><button id="stop">Stop voice</button><pre id="status"></pre><script type="module" src="/client.js"></script>',
        );
      } else if (
        [
          "/worklets/voice-session-uplink.js",
          "/worklets/voice-session-downlink.js",
          "/worklets/playback-reference-tap.js",
        ].includes((request.url ?? "").split("?")[0])
      ) {
        response.setHeader("Content-Type", "application/javascript");
        response.end(
          await readFile(
            path.join(
              root,
              "packages/ui/src/voice",
              (request.url ?? "").split("?")[0].slice(1),
            ),
          ),
        );
      } else if (request.url === "/client.js") {
        response.setHeader("Content-Type", "application/javascript");
        response.end(script);
      } else if (request.url === "/api/conversations") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({ conversations: [{ id: conversationId }] }),
        );
      } else if (request.url?.includes("/messages/stream")) {
        const authorization = await resolveAuthorizedRouteRole(request, {
          state,
          allowTrustedLocalBypass: false,
        });
        if (
          !authorization.ok ||
          authorization.role !== "OWNER" ||
          authorization.identityId !== "owner"
        ) {
          response.writeHead(403);
          response.end();
          return;
        }
        replies++;
        response.setHeader("Content-Type", "text/event-stream");
        response.end(
          `event: done\ndata: ${JSON.stringify({ type: "done", text: "The controlled voice check is complete.", actionResults: [] })}\n\n`,
        );
      } else if (!(await host.handleRequest(request, response))) {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  server.on("upgrade", (request, socket, head) => {
    hostSockets++;
    void host.handleUpgrade(request, socket, head);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const health = await fetch(
    `${origin}/api/v1/voice/session/health?conversationId=${conversationId}`,
    { headers: { Authorization: "Bearer controlled-owner-session" } },
  );
  expect(await health.json()).toMatchObject({
    ready: true,
    speechRoute: "cloud",
  });
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  cleanups.push(() => browser.close());
  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1100, height: 820 },
    recordVideo: { dir: output, size: { width: 1100, height: 820 } },
  });
  cleanups.push(() => context.close());
  const page = await context.newPage();
  cleanups.push(() =>
    page.evaluate("window.voiceEvidence?.stop()").catch(() => {}),
  );
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  try {
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Start voice", exact: true })
      .click();
    await page.waitForFunction(
      "window.voiceEvidence?.snapshot().phase === 'listening'",
      undefined,
      { timeout: 30000 },
    );
    await page.waitForFunction("window.voiceEvidence.snapshot().replies >= 1", {
      timeout: 30000,
    });
    await expect
      .poll(() => relay.snapshot().windows, { timeout: 75000 })
      .toBeGreaterThanOrEqual(2);
    await page.waitForFunction("window.voiceEvidence.snapshot().replies >= 2", {
      timeout: 25000,
    });
    await new Promise((resolve) => setTimeout(resolve, 12000));
    const live = await page.evaluate("window.voiceEvidence.snapshot()");
    expect(live).toMatchObject({
      captures: 1,
      activeTracks: 1,
      mints: 1,
      sockets: 1,
      errors: [],
    });
    expect(hostSockets).toBe(1);
    expect(cloudConsentAttempts).toBe(2);
    expect(relay.snapshot().pcmBytes).toBeGreaterThan(32000);
    expect(
      relay.events.filter((event) => event.event === "extend"),
    ).toHaveLength(1);
    await page.screenshot({ path: path.join(output, "desktop-live.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, "mobile-live.png") });
    await page.getByRole("button", { name: "Stop voice", exact: true }).click();
    await page.waitForFunction(
      "window.voiceEvidence.snapshot().activeTracks === 0 && window.voiceEvidence.snapshot().phase === 'idle'",
    );
    await expect
      .poll(() => relay.snapshot().record?.retirement?.proof?.state)
      .toBe("confirmed");
    expect(replies).toBeGreaterThanOrEqual(2);
    expect(relay.errors).toEqual([]);
    expect(browserErrors).toEqual([]);
    const evidence = {
      video: await page.video()?.path(),
      scope:
        "controlled browser/host/relay; synthetic STT/TTS; zero price; no live service or physical-device qualification",
      live,
      stopped: await page.evaluate("window.voiceEvidence.snapshot()"),
      hostSockets,
      cloudConsentAttempts,
      replies,
      relay: relay.snapshot(),
      events: relay.events,
    };
    await writeFile(
      path.join(output, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    await page.screenshot({ path: path.join(output, "mobile-stopped.png") });
  } catch (error) {
    await writeFile(
      path.join(output, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          browser: await page
            .evaluate("window.voiceEvidence?.snapshot()")
            .catch(() => null),
          events: relay.events,
          relay: relay.snapshot(),
          errors: relay.errors.map(String),
          browserErrors,
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: path.join(output, "failed.png") });
    throw error;
  } finally {
    await dispose();
  }
}, 600000);
