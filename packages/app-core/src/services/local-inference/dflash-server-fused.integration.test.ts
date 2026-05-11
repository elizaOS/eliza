/**
 * Integration smoke for the fused omnivoice `llama-server`: one process,
 * one llama.cpp build (packages/inference/AGENTS.md §4 — no IPC second TTS
 * process; remaining-work-ledger P0 #3 merged-route item).
 *
 * The test spawns the real fused `llama-server` (the `*-fused` build
 * produced by `node packages/app-core/scripts/build-llama-cpp-dflash.mjs
 * --target <triple>-fused`) against a small staged text GGUF and asserts:
 *   1. `POST /completion` does a 1-token text generation,
 *   2. `POST /v1/audio/speech` is mounted and answers from the *same PID*
 *      (returns the structured 503 "not configured" body when no OmniVoice
 *      GGUF is wired, which still proves the route is live and in-process —
 *      with `--omnivoice-model` / `--omnivoice-codec` it synthesizes), and
 *   3. cancelling an in-flight generation drains cleanly (the cancel signal
 *      aborts the request without leaving the server wedged).
 *
 * It SKIPS when no fused build is on disk for this host's backend or no
 * staged text GGUF is found — this is a smoke test against real artifacts,
 * not a hermetic unit test. The unit-level "fused-vs-two-process spawn
 * selection" coverage lives in `dflash-server.test.ts`.
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

function elizaStateDir(): string {
  return (
    process.env.ELIZA_STATE_DIR?.trim() ||
    process.env.MILADY_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".eliza")
  );
}

function backendKey(): string {
  if (process.platform === "darwin") return "metal";
  if (process.env.CUDA_VISIBLE_DEVICES && process.env.CUDA_VISIBLE_DEVICES !== "-1") {
    return "cuda";
  }
  return "cpu";
}

function fusedDir(): string {
  return path.join(
    elizaStateDir(),
    "local-inference",
    "bin",
    "dflash",
    `${process.platform}-${process.arch}-${backendKey()}-fused`,
  );
}

/** Smallest text GGUF we can find under the local-inference models dir. */
function findSmallTextGguf(): string | null {
  const dir = path.join(elizaStateDir(), "local-inference", "models");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  // Prefer an explicit small stand-in; fall back to any *.gguf that isn't a
  // drafter / tokenizer / repaired sidecar.
  const explicit = entries.find((e) => /smol|360m|0_6b|0\.6b|1_7b/i.test(e) && e.endsWith(".gguf"));
  if (explicit) return path.join(dir, explicit);
  const generic = entries.find(
    (e) => e.endsWith(".gguf") && !/drafter|tokenizer|repaired|mmproj/i.test(e),
  );
  return generic ? path.join(dir, generic) : null;
}

const FUSED_BIN = path.join(fusedDir(), "llama-server");
const TEXT_GGUF = findSmallTextGguf();
const haveArtifacts = existsSync(FUSED_BIN) && TEXT_GGUF !== null;

// eslint-disable-next-line vitest/no-conditional-tests
const maybe = haveArtifacts ? describe : describe.skip;

maybe("fused llama-server: text + /v1/audio/speech from one process", () => {
  // Spawning a real llama-server can take a while to load weights.
  const STARTUP_MS = 90_000;

  let mod: typeof import("./dflash-server");
  let server: import("./dflash-server").DflashLlamaServer;
  let baseUrl: string;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it("spawns the fused binary, serves /completion and /v1/audio/speech, then cancels cleanly", async () => {
    // Point the runtime at the real .eliza state dir, enable DFlash, and
    // make the bundled shared libs resolvable for the spawned child.
    process.env.ELIZA_STATE_DIR = elizaStateDir();
    process.env.ELIZA_DFLASH_ENABLED = "1";
    process.env.ELIZA_DFLASH_METAL_AUTO = "1"; // no-op off macOS
    const sep = process.platform === "win32" ? ";" : ":";
    const libVar = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
    process.env[libVar] = [fusedDir(), process.env[libVar] ?? ""].filter(Boolean).join(sep);

    mod = await import("./dflash-server");

    // The fused binary must be the one resolveDflashBinary() picks.
    const resolved = mod.resolveFusedDflashBinary();
    expect(resolved).toBe(FUSED_BIN);
    expect(mod.resolveDflashBinary()).toBe(FUSED_BIN);

    server = mod.dflashLlamaServer;
    await server.start({
      targetModelPath: TEXT_GGUF as string,
      drafterModelPath: TEXT_GGUF as string, // unused: disableDrafter below
      contextSize: 512,
      draftContextSize: 512,
      draftMin: 0,
      draftMax: 0,
      gpuLayers: 0,
      draftGpuLayers: 0,
      disableThinking: false,
      disableDrafter: true, // standalone text GGUF — no -md
    });
    baseUrl = server.currentBaseUrl() as string;
    expect(baseUrl).toBeTruthy();
    const pid = (server as unknown as { child: { pid: number } | null }).child?.pid;
    expect(typeof pid).toBe("number");

    // 1) text generation
    const completionRes = await fetch(`${baseUrl}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Hello", n_predict: 1 }),
    });
    expect(completionRes.ok).toBe(true);
    const completion = (await completionRes.json()) as { tokens_predicted?: number };
    expect(completion.tokens_predicted).toBeGreaterThanOrEqual(1);

    // 2) /v1/audio/speech mounted on the SAME process. No OmniVoice GGUF is
    //    wired in this smoke (the stand-in text bundle has no tts/), so the
    //    route answers with the structured "not configured" 503 — which
    //    proves it is live and in-process (a stock llama-server returns 404).
    const speechRoute = server.audioSpeechRoute();
    expect(speechRoute).not.toBeNull();
    expect(speechRoute?.fused).toBe(true);
    expect(speechRoute?.baseUrl).toBe(baseUrl);
    const speechRes = await fetch(`${baseUrl}${speechRoute?.speechPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello there" }),
    });
    // 503 = route present but TTS not configured (no GGUF). 200 = configured
    // and synthesized. Either proves the route is mounted in this process.
    expect([200, 503]).toContain(speechRes.status);
    const speechBody = await speechRes.text();
    if (speechRes.status === 503) {
      expect(speechBody).toContain("omnivoice");
    }

    // Confirm both responses came from the same PID (the server we spawned).
    const stillPid = (server as unknown as { child: { pid: number } | null }).child?.pid;
    expect(stillPid).toBe(pid);

    // 3) barge-in / cancel: an in-flight generation aborted via the request
    //    signal must not wedge the server — a follow-up request succeeds.
    const ac = new AbortController();
    const longGen = server
      .generate({
        prompt: "Tell me a long story about the sea.",
        maxTokens: 256,
        signal: ac.signal,
      })
      .catch((e: unknown) => e); // abort surfaces as a rejection
    setTimeout(() => ac.abort(), 50);
    await longGen;
    // Server is still healthy after the cancel.
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.ok).toBe(true);

    await server.stop();
    expect(server.hasLoadedModel()).toBe(false);
  }, STARTUP_MS);
});
