// Walkthrough driver against a LOCAL static HTML fixture served over http, in a
// REAL headless Playwright chromium — no mocks, no stubbed browser. Skipped with
// an explicit reason when @playwright/test or its chromium browser is
// unavailable (after attempting nothing destructive; the runner reports the
// skip). Asserts the driver records a video, per-step screenshots, and an ARIA
// snapshot, executes every step in order, and fails fast on a false assertion.
// The teardown/recording-selection contract (browser closed on every failure
// path, step error winning over close noise, this-run's recording picked over a
// stale one, non-http(s) goto rejection) is asserted tool-free against an
// injected structural browser, where each failure can be provoked exactly.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type RunWalkthroughOptions, runWalkthrough } from "./driver.ts";
import { serveFixture } from "./fixture-server.ts";
import {
  parseWalkthroughDef,
  type WalkthroughDef,
} from "./walkthrough-schema.ts";

const dir = mkdtempSync(join(os.tmpdir(), "evidence-driver-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Can we launch a real headless chromium? Gate the browser lane honestly. */
async function chromiumLaunchable(): Promise<boolean> {
  try {
    const { chromium } = (await import("@playwright/test")) as {
      chromium: { launch(o?: unknown): Promise<{ close(): Promise<void> }> };
    };
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    // error-policy:J4 test-capability gate — an absent browser download is a
    // skipped lane with a reason, not a failed test.
    return false;
  }
}

const hasChromium = await chromiumLaunchable();

// A minimal fixture with one button that swaps visible text on click, so the
// driver can exercise goto/waitFor/click/assertText/screenshot/aria on real DOM.
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head>
<body>
  <button data-testid="go" aria-label="Go">Go</button>
  <p data-testid="out">idle</p>
  <script>
    document.querySelector('[data-testid="go"]').addEventListener('click', () => {
      document.querySelector('[data-testid="out"]').textContent = 'done';
    });
  </script>
</body></html>`;

describe.skipIf(!hasChromium)("runWalkthrough (real chromium)", () => {
  it("records a video, screenshots, and an aria snapshot over a fixture", async () => {
    const fixtureDir = mkdtempSync(join(dir, "fixture-"));
    writeFileSync(join(fixtureDir, "index.html"), FIXTURE_HTML);
    const server = await serveFixture(fixtureDir);
    const out = mkdtempSync(join(dir, "out-"));
    try {
      const def = parseWalkthroughDef(
        {
          slug: "driver-fixture",
          granularity: "feature",
          baseUrl: server.baseUrl,
          steps: [
            { action: "goto", value: "/", label: "open" },
            {
              action: "waitFor",
              selector: '[data-testid="go"]',
              label: "await-button",
            },
            {
              action: "assertText",
              selector: '[data-testid="out"]',
              value: "idle",
            },
            {
              action: "click",
              selector: '[data-testid="go"]',
              label: "click",
              ariaAfter: true,
            },
            {
              action: "assertText",
              selector: '[data-testid="out"]',
              value: "done",
              label: "result",
              screenshotAfter: true,
            },
          ],
        },
        "test",
      );
      const result = await runWalkthrough(def, {
        out,
        stepPauseMs: 100,
      });
      expect(result.steps).toHaveLength(5);
      expect(result.steps.map((s) => s.action)).toEqual([
        "goto",
        "waitFor",
        "assertText",
        "click",
        "assertText",
      ]);
      expect(result.screenshots).toHaveLength(1);
      expect(result.ariaSnapshots).toHaveLength(1);
      expect(statSync(result.video).size).toBeGreaterThan(0);
      expect(statSync(result.stepsLog).size).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  }, 60_000);

  it("fails fast when an assertText does not hold", async () => {
    const fixtureDir = mkdtempSync(join(dir, "fixture-fail-"));
    writeFileSync(join(fixtureDir, "index.html"), FIXTURE_HTML);
    const server = await serveFixture(fixtureDir);
    const out = mkdtempSync(join(dir, "out-fail-"));
    try {
      const def = parseWalkthroughDef(
        {
          slug: "driver-fail",
          granularity: "feature",
          baseUrl: server.baseUrl,
          steps: [
            { action: "goto", value: "/" },
            {
              action: "assertText",
              selector: '[data-testid="out"]',
              value: "this text is never present",
            },
          ],
        },
        "test",
      );
      await expect(
        runWalkthrough(def, { out, stepPauseMs: 0 }),
      ).rejects.toMatchObject({ code: "WALKTHROUGH_ASSERTION_FAILED" });
    } finally {
      await server.stop();
    }
  }, 60_000);
});

describe("runWalkthrough guards", () => {
  it("refuses a requiresApp definition without a baseUrl", async () => {
    const def = parseWalkthroughDef(
      {
        slug: "needs-app",
        granularity: "walkthrough",
        requiresApp: true,
        steps: [{ action: "goto", value: "/" }],
      },
      "test",
    );
    await expect(
      runWalkthrough(def, { out: join(dir, "never") }),
    ).rejects.toMatchObject({ code: "WALKTHROUGH_REQUIRES_APP" });
  });
});

type FakeChromium = NonNullable<RunWalkthroughOptions["browser"]>;

/**
 * Structural browser matching the driver's Pw* contract, with injectable
 * failures at each lifecycle stage and a recording written on context.close
 * (mirroring how real Playwright flushes the video file).
 */
function fakeChromium(behavior: {
  newContextError?: Error;
  gotoError?: Error;
  contextCloseError?: Error;
  /** File written into recordVideo.dir when the context closes. */
  videoName?: string;
}): {
  chromium: FakeChromium;
  calls: { browserClosed: boolean; contextClosed: boolean };
} {
  const calls = { browserClosed: false, contextClosed: false };
  let videoDir: string | undefined;
  const locator = {
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {},
    fill: async () => {},
    waitFor: async () => {},
    first: () => locator,
    textContent: async () => "fake",
  };
  const page = {
    goto: async () => {
      if (behavior.gotoError !== undefined) throw behavior.gotoError;
      return undefined;
    },
    locator: () => locator,
    waitForTimeout: async () => {},
    evaluate: async () => undefined,
    screenshot: async (options: { path: string }) => {
      writeFileSync(options.path, "png");
      return Buffer.from("png");
    },
    ariaSnapshot: async () => "- fake",
    content: async () => "",
    close: async () => {},
  };
  const context = {
    newPage: async () => page,
    close: async () => {
      calls.contextClosed = true;
      if (videoDir !== undefined && behavior.videoName !== undefined) {
        writeFileSync(join(videoDir, behavior.videoName), "webm-bytes");
      }
      if (behavior.contextCloseError !== undefined) {
        throw behavior.contextCloseError;
      }
    },
  };
  const browser = {
    newContext: async (options: { recordVideo: { dir: string } }) => {
      videoDir = options.recordVideo.dir;
      if (behavior.newContextError !== undefined) {
        throw behavior.newContextError;
      }
      return context;
    },
    close: async () => {
      calls.browserClosed = true;
    },
  };
  return { chromium: { launch: async () => browser }, calls };
}

const FAKE_DEF: WalkthroughDef = {
  slug: "fake-run",
  granularity: "feature",
  steps: [{ action: "goto", value: "/" }],
};

describe("runWalkthrough teardown and recording selection (fake browser)", () => {
  it("picks this run's recording, never a stale one left in .video", async () => {
    const out = mkdtempSync(join(dir, "stale-"));
    // A previous run's recording; alphabetically FIRST so a naive files[0]
    // pick would ingest it instead of the fresh one.
    mkdirSync(join(out, ".video"), { recursive: true });
    writeFileSync(join(out, ".video", "aaa-stale.webm"), "stale-bytes");
    const { chromium } = fakeChromium({ videoName: "zzz-fresh.webm" });
    const result = await runWalkthrough(FAKE_DEF, {
      out,
      baseUrl: "http://127.0.0.1:1/",
      browser: chromium,
      stepPauseMs: 0,
    });
    expect(basename(result.video)).toBe("zzz-fresh.webm");
    expect(existsSync(join(out, ".video", "aaa-stale.webm"))).toBe(false);
  });

  it("closes the browser when context creation fails", async () => {
    const { chromium, calls } = fakeChromium({
      newContextError: new Error("disk full during recordVideo setup"),
    });
    await expect(
      runWalkthrough(FAKE_DEF, {
        out: mkdtempSync(join(dir, "leak-")),
        baseUrl: "http://127.0.0.1:1/",
        browser: chromium,
        stepPauseMs: 0,
      }),
    ).rejects.toThrow("disk full during recordVideo setup");
    expect(calls.browserClosed).toBe(true);
  });

  it("surfaces the step error, not a context.close rejection, and still closes the browser", async () => {
    const { chromium, calls } = fakeChromium({
      gotoError: new Error("step-boom"),
      contextCloseError: new Error("close-boom"),
      videoName: "run.webm",
    });
    await expect(
      runWalkthrough(FAKE_DEF, {
        out: mkdtempSync(join(dir, "mask-")),
        baseUrl: "http://127.0.0.1:1/",
        browser: chromium,
        stepPauseMs: 0,
      }),
    ).rejects.toThrow("step-boom");
    expect(calls.contextClosed).toBe(true);
    expect(calls.browserClosed).toBe(true);
  });

  it("surfaces a context.close rejection when the steps themselves succeeded", async () => {
    const { chromium, calls } = fakeChromium({
      contextCloseError: new Error("close-boom"),
      videoName: "run.webm",
    });
    await expect(
      runWalkthrough(FAKE_DEF, {
        out: mkdtempSync(join(dir, "close-")),
        baseUrl: "http://127.0.0.1:1/",
        browser: chromium,
        stepPauseMs: 0,
      }),
    ).rejects.toThrow("close-boom");
    expect(calls.browserClosed).toBe(true);
  });

  it("rejects a goto that resolves to a non-http(s) URL before it reaches the page", async () => {
    const fileDef: WalkthroughDef = {
      slug: "file-goto",
      granularity: "feature",
      steps: [{ action: "goto", value: "file:///etc/passwd" }],
    };
    const { chromium } = fakeChromium({ videoName: "run.webm" });
    await expect(
      runWalkthrough(fileDef, {
        out: mkdtempSync(join(dir, "scheme-")),
        baseUrl: "http://127.0.0.1:1/",
        browser: chromium,
        stepPauseMs: 0,
      }),
    ).rejects.toMatchObject({ code: "WALKTHROUGH_URL_SCHEME" });
  });

  it("rejects a relative goto against a non-http(s) baseUrl", async () => {
    const { chromium } = fakeChromium({ videoName: "run.webm" });
    await expect(
      runWalkthrough(FAKE_DEF, {
        out: mkdtempSync(join(dir, "scheme-base-")),
        baseUrl: "file:///srv/app/",
        browser: chromium,
        stepPauseMs: 0,
      }),
    ).rejects.toMatchObject({ code: "WALKTHROUGH_URL_SCHEME" });
  });
});
