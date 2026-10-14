/**
 * Real local HTTP/SQLite/native speech acceptance for the standalone Paradee
 * TTS and libelizainference ASR routes; requires preinstalled, verified assets.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "../../../plugins/plugin-sqlite/adapter.ts";
import { handleRuntimeModePreDispatch } from "../../agent/src/api/runtime-mode/pre-dispatch.ts";
import { __resetRuntimeModeSnapshotCacheForTests } from "../../agent/src/api/runtime-mode/runtime-mode.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { createMachineSession } from "../src/api/auth/sessions.ts";
import type { CompatRuntimeState } from "../src/api/compat-route-shared.ts";
import { enforceCompatRouteAuthPolicy } from "../src/api/route-auth-policy.ts";
import {
  closeStandaloneSpeech,
  handleStandaloneSpeechRoute,
  stopStandaloneSpeech,
} from "../src/api/standalone-speech-routes.ts";
import { authStoreForRuntime } from "../src/services/auth-store.ts";

assert.ok(
  process.env.ELIZA_INFERENCE_LIBRARY &&
    process.env.ELIZA_INFERENCE_LIBRARY_SHA256 &&
    process.env.ELIZA_PARADEE_MODEL_DIR &&
    process.env.ELIZA_ASR_MODEL_DIR,
  "Set absolute ELIZA_INFERENCE_LIBRARY, its reviewed ELIZA_INFERENCE_LIBRARY_SHA256, ELIZA_PARADEE_MODEL_DIR and ELIZA_ASR_MODEL_DIR; this test never downloads assets",
);
const output = testOutputPath("standalone-speech-http");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "state-"));
process.env.ELIZA_STATE_DIR = directory;
process.env.ELIZA_CONFIG_PATH = path.join(directory, "eliza.json");
process.env.ELIZA_API_TOKEN = randomUUID();
process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
process.env.ELIZA_PARADEE_ENABLED = "0";
process.env.ELIZA_ASR_ENABLED = "0";
const adapters: SQLiteDatabaseAdapter[] = [];
const opened: Array<{
  server: http.Server;
  state: CompatRuntimeState;
  adapter: SQLiteDatabaseAdapter;
}> = [];
async function start(name: string) {
  const agentId = randomUUID() as UUID;
  const adapter = SQLiteDatabaseAdapter.create(
    path.join(directory, `${name}.sqlite`),
    agentId,
  );
  adapters.push(adapter);
  await adapter.initialize();
  const runtime = new AgentRuntime({ agentId, character: { name }, adapter });
  const store = authStoreForRuntime(runtime);
  assert.ok(
    store,
    "Runtime must provide real persistent authentication storage",
  );
  const owner = await store.createIdentity({
    id: randomUUID(),
    kind: "owner",
    displayName: "Synthetic speech owner",
    createdAt: Date.now(),
  });
  const guest = await store.createIdentity({
    id: randomUUID(),
    kind: "machine",
    displayName: "Synthetic guest",
    createdAt: Date.now(),
  });
  const token = (
    await createMachineSession(store, { identityId: owner.id, scopes: [] })
  ).session.id;
  const guestToken = (
    await createMachineSession(store, { identityId: guest.id, scopes: [] })
  ).session.id;
  const state: CompatRuntimeState = {
    current: runtime,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
  let retireNext = false;
  const server = http.createServer((req, res) => {
    void (async () => {
      if (await handleRuntimeModePreDispatch(req, res, state.current)) return;
      if (
        (await enforceCompatRouteAuthPolicy(
          req,
          res,
          state,
          req.method ?? "GET",
          new URL(req.url ?? "/", "http://localhost").pathname,
        )) === "denied"
      )
        return;
      const handled = handleStandaloneSpeechRoute(req, res, state);
      // A real host retirement after dispatch, while asynchronous auth is pending.
      if (retireNext) {
        retireNext = false;
        stopStandaloneSpeech(state);
      }
      if (!(await handled)) {
        res.writeHead(404);
        res.end();
      }
    })().catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  opened.push({ server, state, adapter });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const status = async (bearer = token, route = "/api/tts/paradee") => {
    const response = await fetch(`${base}${route}/status`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, value: await response.json() };
  };
  const post = (
    text: unknown,
    id = randomUUID(),
    bearer = token,
    signal: AbortSignal = AbortSignal.timeout(45000),
  ) =>
    fetch(`${base}/api/tts/paradee`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        "X-Request-Id": id,
      },
      body: JSON.stringify(text),
      signal,
    });
  const transcribe = (
    wav: Buffer,
    id = randomUUID(),
    signal: AbortSignal = AbortSignal.timeout(100000),
  ) =>
    fetch(`${base}/api/asr/libelizainference`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "audio/wav",
        "X-Request-Id": id,
      },
      body: wav,
      signal,
    });
  return {
    state,
    server,
    transcribe,
    store,
    token,
    guestToken,
    status,
    post,
    retireOnNextDispatch: () => {
      retireNext = true;
    },
  };
}
try {
  const first = await start("First"),
    second = await start("Second");
  for (const mode of ["cloud", "remote"]) {
    await writeFile(
      process.env.ELIZA_CONFIG_PATH!,
      JSON.stringify({
        deploymentTarget: {
          runtime: mode,
          ...(mode === "remote" ? { remoteApiBase: "http://127.0.0.1:1" } : {}),
        },
      }),
    );
    __resetRuntimeModeSnapshotCacheForTests();
    assert.equal((await first.status()).status, 404);
  }
  await writeFile(
    process.env.ELIZA_CONFIG_PATH!,
    JSON.stringify({
      deploymentTarget: { runtime: "local" },
      cloud: { enabled: false },
    }),
  );
  __resetRuntimeModeSnapshotCacheForTests();
  assert.equal((await first.status("invalid")).status, 401);
  assert.equal((await first.status(process.env.ELIZA_API_TOKEN)).status, 403);
  assert.equal((await first.status(first.guestToken)).status, 403);
  assert.equal((await first.status()).value.ready, false);
  first.retireOnNextDispatch();
  assert.equal((await first.status()).status, 409);
  process.env.ELIZA_PARADEE_ENABLED = "1";
  process.env.ELIZA_ASR_ENABLED = "1";
  assert.equal((await first.status()).value.ready, true);
  assert.equal(
    (await first.status(undefined, "/api/asr/libelizainference")).value.ready,
    true,
  );
  assert.equal((await second.status()).value.ready, true);
  console.log("Authenticated hosts ready; retirement during auth refused");
  assert.equal((await first.post({ text: "x".repeat(501) })).status, 422);
  assert.equal(
    (await first.post({ text: "<think>private reasoning</think>" })).status,
    422,
  );
  assert.equal(
    (await first.post({ text: "Hello", voice: "other" })).status,
    422,
  );
  const phrase = "Please remember to water the plants tomorrow morning.";
  const requestId = randomUUID();
  const response = await first.post({ text: phrase }, requestId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), requestId);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const audio = Buffer.from(await response.arrayBuffer());
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.toString("ascii", 8, 12), "WAVE");
  assert.equal(audio.readUInt32LE(24), 24000);
  assert.equal(audio.readUInt16LE(34), 16);
  assert.ok(audio.length > 44);
  await writeFile(path.join(output, "speech.wav"), audio);
  assert.equal((await first.post({ text: phrase }, requestId)).status, 409);
  // Independent hosts do not share replay or busy state.
  const other = await second.post({ text: phrase }, requestId);
  assert.equal(other.status, 200);
  await other.arrayBuffer();
  console.log("Native speech, replay and independent-host checks passed");
  // Round trip: Paradee speech in, Qwen3-ASR transcript out.
  const heard = await first.transcribe(audio);
  assert.equal(heard.status, 200);
  const transcript = await heard.json();
  assert.equal(transcript.provider, "local-inference");
  assert.ok(
    /water/i.test(transcript.text) && /plants/i.test(transcript.text),
    `Transcript must contain the spoken words: ${transcript.text}`,
  );
  // A client abort cancels the native call; the worker stays loaded.
  const long = Buffer.concat([audio, ...Array(3).fill(audio.subarray(44))]);
  long.writeUInt32LE(long.length - 8, 4);
  long.writeUInt32LE(long.length - 44, 40);
  const abort = new AbortController();
  const aborted = first.transcribe(long, randomUUID(), abort.signal);
  for (let count = 0; count < 200; count++) {
    if (
      (await first.status(undefined, "/api/asr/libelizainference")).value.busy
    )
      break;
    await Bun.sleep(10);
  }
  abort.abort();
  await assert.rejects(aborted);
  const after = await first.transcribe(audio);
  assert.equal(after.status, 200);
  await after.json();
  console.log("Native transcription and cancellation checks passed");
  const cancelled = first.post({ text: Array(7).fill(phrase).join(" ") });
  let busy = false;
  for (let count = 0; count < 100; count++) {
    if ((await first.status()).value.busy) {
      busy = true;
      break;
    }
    await Bun.sleep(10);
  }
  assert.ok(
    busy,
    "Must observe dispatched native work before stopping its host",
  );
  stopStandaloneSpeech(first.state);
  assert.notEqual((await cancelled).status, 200);
  assert.equal((await second.status()).value.ready, true);
  assert.equal((await first.status()).value.ready, true);
  const retry = await first.post({ text: phrase });
  assert.equal(retry.status, 200);
  await retry.arrayBuffer();
  closeStandaloneSpeech(second.state);
  assert.equal((await second.status()).status, 503);
  const third = await start("Reopened");
  assert.equal((await third.status()).value.ready, true);
  await first.store.revokeSession(first.token, Date.now());
  assert.equal((await first.status()).status, 401);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        scope:
          "Real HTTP policy, SQLite auth, native worker and WAV; independent host state stop/reopen",
        audioBytes: audio.length,
        transcript: transcript.text,
        checks:
          "auth/role/revoke, disabled, validation, speech, transcription round trip, ASR cancellation, replay, host isolation, dispatched cancellation and reopen",
      },
      null,
      2,
    ),
  );
  console.log("Standalone speech HTTP/SQLite/native acceptance passed");
} finally {
  for (const item of opened) {
    stopStandaloneSpeech(item.state);
    item.server.closeAllConnections();
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
  }
  for (const adapter of adapters) await adapter.close();
  await rm(directory, { recursive: true, force: true });
}
