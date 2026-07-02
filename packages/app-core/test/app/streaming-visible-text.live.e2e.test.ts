/**
 * Live streaming visible-text + frame-contract test.
 *
 * Boots the real API and a minimal HTML harness that consumes the SSE
 * stream from `POST /api/conversations/:id/messages/stream`, then asserts:
 *   1. the visible assistant text grows monotonically as tokens arrive, and
 *   2. the SSE frame contract holds against the live model: a `thinking`
 *      status opens the turn, a producing status (`streaming` for raw LLM
 *      token streams, `running_action` when an action callback produces the
 *      reply) precedes the first `token` frame, `token` frames carry
 *      non-decreasing cumulative `fullText`, and the terminal `done` frame
 *      carries the thought channel (`thought`, when the model emits
 *      reasoning) separate from — never leaked into — the visible text.
 *
 * Gated on `ELIZA_LIVE_TEST=1` plus an LLM API key. Skips cleanly with a
 * loud reason when prerequisites are absent (fail-on-silent-skip pattern).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";
import { selectLiveProvider } from "../helpers/live-provider.ts";

const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const LIVE_PROVIDER = LIVE_TESTS_ENABLED ? selectLiveProvider() : null;
const CHROME_PATH =
  process.env.ELIZA_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_AVAILABLE = existsSync(CHROME_PATH);

const SHOULD_RUN =
  LIVE_TESTS_ENABLED && LIVE_PROVIDER !== null && CHROME_AVAILABLE;

if (LIVE_TESTS_ENABLED && !LIVE_PROVIDER) {
  // Loud signal: live mode is on but no provider key was found.
  console.warn(
    "[streaming-visible-text] ELIZA_LIVE_TEST=1 but no LIVE_PROVIDER selected — skipping suite",
  );
}
if (LIVE_TESTS_ENABLED && !CHROME_AVAILABLE) {
  console.warn(
    `[streaming-visible-text] Chrome not found at ${CHROME_PATH} — skipping suite (set ELIZA_CHROME_PATH)`,
  );
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
// First boot may download the gte-small embedding GGUF (~64MB) before the
// health endpoint comes up; keep headroom for cold caches + slow networks.
const READY_TIMEOUT_MS = 300_000;
const STREAM_DEADLINE_MS = 90_000;

interface Stack {
  apiBase: string;
  apiChild: ChildProcessWithoutNullStreams;
  browser: Browser;
  harnessServer: Server;
  harnessUrl: string;
  stateDir: string;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

/**
 * `/api/health` flips ready before deferred plugins (including the model
 * provider) finish registering. Streaming into that window yields the canned
 * "no LLM provider configured" reply. `/api/status` exposes `canRespond` —
 * true only once a TEXT_GENERATION handler is registered — so gate on it.
 */
async function waitForCanRespond(
  apiBase: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "<unknown>";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/api/status`);
      if (response.ok) {
        const status = (await response.json()) as {
          state?: string;
          canRespond?: boolean;
        };
        lastState = `state=${status.state} canRespond=${status.canRespond}`;
        if (status.canRespond === true) return;
      }
    } catch {
      // keep polling until the deadline
    }
    await sleep(1_000);
  }
  throw new Error(
    `Timed out waiting for canRespond=true at ${apiBase}/api/status (last: ${lastState})`,
  );
}

/**
 * Minimal HTML page that:
 *   1. Creates a conversation.
 *   2. POSTs the user message to the streaming endpoint.
 *   3. Reads SSE frames and appends `text` deltas to a visible div.
 *   4. Records EVERY parsed SSE payload (status/token/done/…) in arrival
 *      order into `window.__frames` for frame-contract assertions.
 *
 * The browser then samples that div via Playwright.
 */
function makeHarnessHtml(apiBase: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>streaming harness</title></head>
<body>
  <div id="status">idle</div>
  <div data-testid="assistant-message"></div>
  <script>
    const apiBase = ${JSON.stringify(apiBase)};
    const out = document.querySelector('[data-testid="assistant-message"]');
    const status = document.getElementById('status');

    window.__samples = [];
    window.__frames = [];
    window.__startStream = async function(prompt) {
      try {
      status.textContent = 'creating-conversation';
      const created = await fetch(apiBase + '/api/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'streaming-test' })
      });
      if (!created.ok) {
        status.textContent = 'create-failed:' + created.status;
        return;
      }
      const conv = await created.json();
      const convId = conv.id || conv.conversation?.id;
      if (!convId) {
        status.textContent = 'no-conv-id';
        return;
      }
      status.textContent = 'streaming';

      const resp = await fetch(apiBase + '/api/conversations/' + convId + '/messages/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: prompt })
      });
      if (!resp.ok || !resp.body) {
        status.textContent = 'stream-failed:' + resp.status;
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\\n\\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const line = frame.split('\\n').find(function(l){return l.startsWith('data: ');});
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice('data: '.length));
            window.__frames.push({ t: Date.now(), payload: payload });
            if (payload.type === 'token' && typeof payload.fullText === 'string') {
              out.textContent = payload.fullText;
              window.__samples.push({ t: Date.now(), len: payload.fullText.length });
            } else if (payload.type === 'done' && typeof payload.fullText === 'string') {
              out.textContent = payload.fullText;
              window.__samples.push({ t: Date.now(), len: payload.fullText.length, done: true });
            }
          } catch (_) { /* skip non-JSON SSE noise */ }
        }
      }
      status.textContent = 'done';
      } catch (error) {
        status.textContent = 'exception:' + (error && error.message ? error.message : String(error));
      }
    };
  </script>
</body>
</html>`;
}

async function startHarnessServer(args: {
  apiBase: string;
  port: number;
}): Promise<Server> {
  const html = makeHarnessHtml(args.apiBase);
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", () => resolve());
  });
  return server;
}

async function ensureAgentDevDistLinks(): Promise<void> {
  const distRoot = path.join(REPO_ROOT, "packages/agent/dist");
  const nestedSrc = path.join(distRoot, "packages/agent/src");
  let entries: string[];
  try {
    entries = await readdir(nestedSrc);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(nestedSrc, entry);
      const link = path.join(distRoot, entry);
      try {
        await unlink(link);
      } catch {
        /* absent or non-symlink; keep going */
      }
      try {
        await symlink(target, link);
      } catch {
        /* best effort; startup will surface any unresolved import */
      }
    }),
  );
}

async function startStack(): Promise<Stack> {
  const stateRoot = path.join(REPO_ROOT, ".tmp");
  await mkdir(stateRoot, { recursive: true });
  // Persistent cache for immutable model artifacts (the gte-small embedding
  // GGUF). The state dir is a throwaway mkdtemp per run, so without this
  // every run re-downloads ~64MB and can blow the ready timeout.
  const modelsCacheDir = path.join(stateRoot, "eliza-live-models");
  await mkdir(modelsCacheDir, { recursive: true });
  await ensureAgentDevDistLinks();
  const stateDir = await mkdtemp(path.join(stateRoot, "eliza-streaming-live-"));
  const apiPort = await getFreePort();
  const harnessPort = await getFreePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  const apiChild = spawn(
    "node",
    [
      path.join(REPO_ROOT, "packages/app-core/scripts/run-node-tsx.mjs"),
      path.join(
        REPO_ROOT,
        "packages/app-core/test/scripts/start-eliza-live.ts",
      ),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...(LIVE_PROVIDER?.env ?? {}),
        FORCE_COLOR: "0",
        ALLOW_NO_DATABASE: "",
        ELIZA_API_PORT: String(apiPort),
        ELIZA_PORT: String(apiPort),
        ELIZA_ALLOWED_ORIGINS: `http://127.0.0.1:${harnessPort}`,
        ELIZA_STATE_DIR: stateDir,
        MODELS_DIR: modelsCacheDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  apiChild.stdout.on("data", (chunk) => {
    process.stdout.write(`[streaming-live][api] ${chunk}`);
  });
  apiChild.stderr.on("data", (chunk) => {
    process.stdout.write(`[streaming-live][api-err] ${chunk}`);
  });
  apiChild.on("exit", (code, signal) => {
    process.stdout.write(
      `[streaming-live][api-exit] code=${code ?? "null"} signal=${signal ?? "null"}\n`,
    );
  });

  await waitForUrl(`${apiBase}/api/health`, READY_TIMEOUT_MS);
  await waitForCanRespond(apiBase, READY_TIMEOUT_MS);

  const harnessServer = await startHarnessServer({
    apiBase,
    port: harnessPort,
  });

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--use-angle=swiftshader"],
  });

  return {
    apiBase,
    apiChild,
    browser,
    harnessServer,
    harnessUrl: `http://127.0.0.1:${harnessPort}/`,
    stateDir,
  };
}

async function stopStack(stack: Stack | null): Promise<void> {
  if (!stack) return;
  // Teardown must never hang the suite: a wedged Chrome or a lingering
  // keep-alive socket previously stalled `browser.close()` /
  // `harnessServer.close()` past the hook timeout, leaking the API child.
  await Promise.race([
    stack.browser.close().catch(() => undefined),
    sleep(15_000),
  ]);
  stack.harnessServer.closeAllConnections();
  await Promise.race([
    new Promise<void>((resolve) => {
      stack.harnessServer.close(() => resolve());
    }),
    sleep(10_000),
  ]);
  if (stack.apiChild.exitCode == null) {
    stack.apiChild.kill("SIGTERM");
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      stack.apiChild.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited && stack.apiChild.exitCode == null) {
      stack.apiChild.kill("SIGKILL");
    }
  }
  await rm(stack.stateDir, { force: true, recursive: true });
}

const describeLive = describeIf(SHOULD_RUN);

describeLive("streaming-visible-text live e2e", () => {
  let stack: Stack | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  beforeAll(
    async () => {
      stack = await startStack();
      context = await stack.browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      page = await context.newPage();
      page.on("console", (message) => {
        console.log(
          `[streaming-live][browser:${message.type()}] ${message.text()}`,
        );
      });
      // Covers both boot gates: /api/health ready + /api/status canRespond.
    },
    READY_TIMEOUT_MS * 2 + 30_000,
  );

  afterAll(async () => {
    if (context) {
      await context.close().catch(() => undefined);
    }
    await stopStack(stack);
  });

  it(
    "assistant message text grows monotonically as tokens arrive",
    async () => {
      if (!stack || !page) throw new Error("stack/page not initialized");

      await page.goto(stack.harnessUrl);
      await page.waitForSelector('[data-testid="assistant-message"]', {
        state: "attached",
      });

      // Kick off the streamed completion.
      await page.evaluate(() => {
        const w = window as unknown as {
          __startStream: (prompt: string) => Promise<void>;
        };
        void w.__startStream(
          "Reply directly with twelve numbered sentences about cats. Keep each sentence at least eight words. Do not mention memory or tools.",
        );
      });

      const samples: { t: number; len: number; text: string }[] = [];
      const deadline = Date.now() + STREAM_DEADLINE_MS;
      let lastLen = -1;
      let stableCount = 0;
      while (Date.now() < deadline) {
        const text = await page
          .locator('[data-testid="assistant-message"]')
          .innerText()
          .catch(() => "");
        const len = text.length;
        samples.push({ t: Date.now(), len, text });

        if (len === lastLen) {
          stableCount += 1;
          if (stableCount >= 8 && len > 0) break;
        } else {
          stableCount = 0;
          lastLen = len;
        }

        const status = await page
          .locator("#status")
          .innerText()
          .catch(() => "");
        if (status === "done" && len > 0) break;
        if (
          status.startsWith("create-failed") ||
          status.startsWith("stream-failed") ||
          status.startsWith("exception:")
        ) {
          throw new Error(`Harness reported error: ${status}`);
        }

        await page.waitForTimeout(100);
      }

      const browserStreamSamples = await page.evaluate(() => {
        const w = window as unknown as {
          __samples?: Array<{ t: number; len: number; done?: boolean }>;
        };
        return w.__samples ?? [];
      });
      const distinctNonEmpty = [...browserStreamSamples, ...samples]
        .sort((a, b) => a.t - b.t)
        .filter((sample) => sample.len > 0)
        .map((sample) => sample.len);

      const distinct = Array.from(new Set(distinctNonEmpty));
      expect(
        distinct.length,
        `Expected ≥5 distinct visible-text lengths to indicate streaming, got: ${JSON.stringify(distinct)} final=${JSON.stringify(samples.findLast((sample) => sample.len > 0)?.text ?? "")}`,
      ).toBeGreaterThanOrEqual(5);

      // Monotonic-non-decreasing across the stream of samples.
      const visibleDomLengths = samples
        .filter((sample) => sample.len > 0)
        .map((sample) => sample.len);
      for (let i = 1; i < visibleDomLengths.length; i += 1) {
        expect(
          visibleDomLengths[i],
          `Visible text shrank at sample ${i}: ${visibleDomLengths[i - 1]} -> ${visibleDomLengths[i]}`,
        ).toBeGreaterThanOrEqual(visibleDomLengths[i - 1]);
      }

      // Final text should be substantive (cats paragraph).
      const finalText = samples[samples.length - 1]?.text ?? "";
      expect(finalText.length).toBeGreaterThan(40);
    },
    STREAM_DEADLINE_MS + 30_000,
  );

  it("SSE frames arrive thinking→producing→tokens→done, with the thought channel separate from visible text", async () => {
    if (!page) throw new Error("page not initialized");

    // Frames were captured by the harness during the previous test's live
    // stream (`window.__frames` records every parsed SSE payload in order).
    const frames = await page.evaluate(() => {
      const w = window as unknown as {
        __frames?: Array<{ t: number; payload: Record<string, unknown> }>;
      };
      return w.__frames ?? [];
    });
    expect(
      frames.length,
      "harness captured no SSE frames — did the streaming test run?",
    ).toBeGreaterThan(0);

    const payloads = frames.map(
      (frame) =>
        frame.payload as Record<string, unknown> & {
          type?: string;
          kind?: string;
          text?: string;
          fullText?: string;
          thought?: string;
          agentName?: string;
        },
    );

    // Evidence hook: dump the raw captured frames for hand review
    // (vitest's default reporter hides per-test console output on pass).
    if (process.env.ELIZA_STREAM_FRAME_DUMP) {
      await writeFile(
        process.env.ELIZA_STREAM_FRAME_DUMP,
        JSON.stringify(frames, null, 2),
      );
    }

    // Evidence log: hand-readable frame sequence (types, status kinds,
    // token growth, and the terminal done frame with its thought).
    const tokenLens = payloads
      .filter((payload) => payload.type === "token")
      .map((payload) => String(payload.fullText ?? "").length);
    console.log(
      `[streaming-live][frames] total=${frames.length} sequence=${JSON.stringify(
        payloads.map((payload) =>
          payload.type === "status"
            ? `status:${payload.kind}`
            : String(payload.type),
        ),
      )}`,
    );
    console.log(
      `[streaming-live][frames] token fullText lengths=${JSON.stringify(tokenLens)}`,
    );

    // ── Status ordering: `thinking` opens the turn, then a producing-phase
    // status precedes the first token frame. The producing status is
    // `streaming` when raw LLM tokens claim the stream (onStreamChunk), or
    // `running_action` when an action handler (e.g. REPLY) produces the
    // visible reply through callbacks — the path observed live with the
    // Cerebras default (gemma-4-31b) through the bootstrap message handler.
    const thinkingIndex = payloads.findIndex(
      (payload) => payload.type === "status" && payload.kind === "thinking",
    );
    const producingIndex = payloads.findIndex(
      (payload) =>
        payload.type === "status" &&
        (payload.kind === "streaming" || payload.kind === "running_action"),
    );
    const firstTokenIndex = payloads.findIndex(
      (payload) => payload.type === "token",
    );
    const doneIndex = payloads.findIndex((payload) => payload.type === "done");
    expect(thinkingIndex, "no thinking status frame").toBeGreaterThanOrEqual(0);
    expect(
      producingIndex,
      "no streaming/running_action status frame",
    ).toBeGreaterThan(thinkingIndex);
    expect(firstTokenIndex, "no token frames").toBeGreaterThan(producingIndex);
    expect(doneIndex, "no done frame").toBeGreaterThan(firstTokenIndex);
    // `done` is terminal — no token frames after it.
    expect(
      payloads.slice(doneIndex + 1).some((payload) => payload.type === "token"),
    ).toBe(false);

    // ── Token frames: cumulative fullText never shrinks.
    for (let i = 1; i < tokenLens.length; i += 1) {
      expect(
        tokenLens[i],
        `token fullText shrank at frame ${i}: ${tokenLens[i - 1]} -> ${tokenLens[i]}`,
      ).toBeGreaterThanOrEqual(tokenLens[i - 1]);
    }

    // ── Done frame contract.
    const done = payloads[doneIndex];
    expect(typeof done.fullText).toBe("string");
    expect(String(done.fullText).length).toBeGreaterThan(0);
    expect(typeof done.agentName).toBe("string");
    expect(String(done.agentName).length).toBeGreaterThan(0);

    // ── Thought channel: a field contract, not a model-behavior demand.
    // When the live model emits reasoning, `done.thought` is a non-empty
    // string that is NOT part of the visible streamed text; a model may
    // legitimately return no reasoning, in which case the field is absent.
    if (done.thought !== undefined) {
      expect(typeof done.thought).toBe("string");
      const thought = String(done.thought).trim();
      expect(thought.length).toBeGreaterThan(0);
      console.log(
        `[streaming-live][thought] present (${thought.length} chars): ${JSON.stringify(thought)}`,
      );
      // Never leaked into the visible token stream or the final text.
      expect(String(done.fullText)).not.toContain(thought);
      for (const payload of payloads) {
        if (payload.type === "token") {
          expect(String(payload.fullText ?? "")).not.toContain(thought);
        }
      }
    } else {
      console.log(
        "[streaming-live][thought] absent — the live model emitted no reasoning for this turn (contract allows absence)",
      );
    }
    console.log(
      `[streaming-live][done] fullText=${JSON.stringify(String(done.fullText))}`,
    );
  }, 60_000);
});
