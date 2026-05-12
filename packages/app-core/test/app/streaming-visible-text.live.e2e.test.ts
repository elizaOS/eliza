/**
 * Live streaming visible-text test.
 *
 * Boots the real API and a minimal HTML harness that consumes the SSE
 * stream from `POST /api/conversations/:id/messages/stream`, then asserts
 * the visible assistant text grows monotonically as tokens arrive.
 *
 * Gated on `ELIZA_LIVE_TEST=1` plus an LLM API key. Skips cleanly with a
 * loud reason when prerequisites are absent (fail-on-silent-skip pattern).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, expect } from "vitest";
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

const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const READY_TIMEOUT_MS = 120_000;
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
 * Minimal HTML page that:
 *   1. Creates a conversation.
 *   2. POSTs the user message to the streaming endpoint.
 *   3. Reads SSE frames and appends `text` deltas to a visible div.
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
    window.__startStream = async function(prompt) {
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
        body: JSON.stringify({ content: { text: prompt } })
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
  const server = createServer(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", () => resolve());
  });
  return server;
}

async function startStack(): Promise<Stack> {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "eliza-streaming-live-"),
  );
  const apiPort = await getFreePort();
  const harnessPort = await getFreePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  const apiChild = spawn(
    "node",
    [
      path.join(REPO_ROOT, "packages/app-core/scripts/run-node-tsx.mjs"),
      path.join(REPO_ROOT, "packages/app-core/src/runtime/eliza.ts"),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        ALLOW_NO_DATABASE: "",
        ELIZA_API_PORT: String(apiPort),
        ELIZA_PORT: String(apiPort),
        ELIZA_STATE_DIR: stateDir,
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

  await waitForUrl(`${apiBase}/api/health`, READY_TIMEOUT_MS);

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
  try {
    await stack.browser.close();
  } catch {
    /* best effort */
  }
  await new Promise<void>((resolve) => {
    stack.harnessServer.close(() => resolve());
  });
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

  beforeAll(async () => {
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
  }, READY_TIMEOUT_MS + 30_000);

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
      await page.waitForSelector('[data-testid="assistant-message"]');

      // Kick off the streamed completion.
      await page.evaluate(() => {
        const w = window as unknown as {
          __startStream: (prompt: string) => Promise<void>;
        };
        void w.__startStream("Tell me a paragraph about cats.");
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
        if (status.startsWith("create-failed") || status.startsWith("stream-failed")) {
          throw new Error(`Harness reported error: ${status}`);
        }

        await page.waitForTimeout(100);
      }

      const distinctNonEmpty = samples
        .filter((sample) => sample.len > 0)
        .map((sample) => sample.len);

      const distinct = Array.from(new Set(distinctNonEmpty));
      expect(
        distinct.length,
        `Expected ≥5 distinct visible-text lengths to indicate streaming, got: ${JSON.stringify(distinct)}`,
      ).toBeGreaterThanOrEqual(5);

      // Monotonic-non-decreasing across the stream of samples.
      for (let i = 1; i < distinctNonEmpty.length; i += 1) {
        expect(
          distinctNonEmpty[i],
          `Visible text shrank at sample ${i}: ${distinctNonEmpty[i - 1]} -> ${distinctNonEmpty[i]}`,
        ).toBeGreaterThanOrEqual(distinctNonEmpty[i - 1]);
      }

      // Final text should be substantive (cats paragraph).
      const finalText = samples[samples.length - 1]?.text ?? "";
      expect(finalText.length).toBeGreaterThan(40);
    },
    STREAM_DEADLINE_MS + 30_000,
  );
});
