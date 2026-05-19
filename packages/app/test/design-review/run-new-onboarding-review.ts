/**
 * New onboarding screenshot/contact-sheet runner.
 *
 * Mounts `packages/ui/src/components/onboarding/states/OnboardingRoot.tsx`
 * directly in a tiny Vite harness, captures every state in the new
 * state-machine at multiple viewports, and writes:
 *
 *   packages/app/test-results/design-review/new-onboarding/manifest.json
 *   packages/app/test-results/design-review/new-onboarding/contact-sheet.html
 *   packages/app/test-results/design-review/new-onboarding/screenshots/*.png
 *
 * Usage:
 *   bunx tsx packages/app/test/design-review/run-new-onboarding-review.ts
 *   ELIZA_DESIGN_REVIEW_HEADLESS=0 bunx tsx packages/app/test/design-review/run-new-onboarding-review.ts
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  type Page,
  type Request,
} from "@playwright/test";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { getFreePort } from "../utils/get-free-port.mjs";

type ViewportId = "mobile" | "desktop";

interface ViewportSpec {
  id: ViewportId;
  label: string;
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
}

interface StateSpec {
  id: string;
  label: string;
  expected: readonly (string | RegExp)[];
  query?: Record<string, string>;
}

interface CaptureRecord {
  stateId: string;
  stateLabel: string;
  viewportId: ViewportId;
  viewportLabel: string;
  viewportSize: string;
  relativePath: string;
}

interface FailureRecord {
  stateId: string;
  viewportId: ViewportId;
  message: string;
  screenshotPath?: string;
  consolePath?: string;
}

interface Manifest {
  generatedAt: string;
  harnessUrl: string;
  captures: CaptureRecord[];
  failures: FailureRecord[];
}

const READY_TIMEOUT_MS = Number.parseInt(
  process.env.ELIZA_DESIGN_REVIEW_READY_TIMEOUT_MS ?? "8000",
  10,
);
const SETTLE_MS = Number.parseInt(
  process.env.ELIZA_DESIGN_REVIEW_SETTLE_MS ?? "900",
  10,
);

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(appRoot, "../..");
const uiRoot = path.join(repoRoot, "packages/ui");
const outputRoot = path.resolve(
  appRoot,
  "test-results/design-review/new-onboarding",
);
const screenshotsRoot = path.join(outputRoot, "screenshots");
const diagnosticsRoot = path.join(outputRoot, "diagnostics");

const viewports: ViewportSpec[] = [
  {
    id: "mobile",
    label: "Mobile",
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "desktop",
    label: "Desktop",
    width: 1440,
    height: 900,
    isMobile: false,
    hasTouch: false,
  },
];

const states: StateSpec[] = [
  { id: "hello", label: "Hello", expected: [/hello/i, /tap to begin/i] },
  {
    id: "setup",
    label: "Setup Choice",
    expected: [/setup your eliza/i, /cloud/i, /on-device/i],
  },
  {
    id: "cloud-login",
    label: "Cloud Login",
    expected: [/eliza cloud/i, /continue with google/i],
  },
  {
    id: "cloud-chat",
    label: "Cloud Placeholder Chat",
    expected: [/cloud handoff/i, /agent-led/i, /enter chat/i],
  },
  {
    id: "remote-pair",
    label: "Remote Pair",
    expected: [/remote agent/i, /^pair$/i],
  },
  {
    id: "device-security",
    label: "Device Security",
    expected: [/on-device/i, /sandbox/i, /no sandbox/i],
  },
  {
    id: "device-mode",
    label: "Device Mode",
    expected: [/local runtime/i, /local \+ cloud services/i, /all local/i],
  },
  {
    id: "local-download",
    label: "Local Download In Progress",
    expected: [/downloading eliza local models/i, /use cloud instead/i],
    query: { download: "progress" },
  },
  {
    id: "local-download",
    label: "Local Download Ready",
    expected: [/downloading eliza local models/i, /ready/i, /continue/i],
    query: { download: "ready" },
  },
  {
    id: "mic",
    label: "Microphone",
    expected: [/microphone/i, /continue/i, /skip voice input/i],
  },
  {
    id: "profile-name",
    label: "Profile Name",
    expected: [/can i get your name/i, /^continue$/i],
  },
  {
    id: "profile-location",
    label: "Profile Location",
    expected: [/where do you live/i, /aosp and linux/i],
  },
  {
    id: "tutorial-settings",
    label: "Tutorial Settings",
    expected: [/settings/i, /ai subscriptions/i],
  },
  {
    id: "tutorial-subscriptions",
    label: "Tutorial Subscriptions",
    expected: [/subscriptions/i, /continue/i],
  },
  {
    id: "tutorial-views",
    label: "Tutorial Views",
    expected: [/views/i, /continue/i],
  },
  {
    id: "tutorial-connectors",
    label: "Tutorial Connectors",
    expected: [/connectors/i, /continue/i],
  },
  {
    id: "tutorial-permissions",
    label: "Tutorial Permissions",
    expected: [/permissions/i, /finish/i],
  },
  { id: "home", label: "Home", expected: [/you're all set/i] },
];

function stateSlug(state: StateSpec): string {
  const suffix = state.query?.download ? `-${state.query.download}` : "";
  return `${state.id}${suffix}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHarnessSource(): string {
  const onboardingRootPath = path
    .join(uiRoot, "src/components/onboarding/states/OnboardingRoot.tsx")
    .replace(/\\/g, "/");
  const storagePath = path
    .join(uiRoot, "src/onboarding/state-persistence.ts")
    .replace(/\\/g, "/");

  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { OnboardingRoot } from "/@fs/${onboardingRootPath}";
    import { ONBOARDING_STORAGE_KEY } from "/@fs/${storagePath}";

    const params = new URLSearchParams(window.location.search);
    const state = params.get("state") || "hello";
    const download = params.get("download");
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);

    const localDownloadProgress =
      download === "ready"
        ? { ratio: 1, meta: "Ready", ready: true }
        : download === "progress"
          ? { ratio: 0.42, meta: "Downloading Eliza-1 weights...", ready: false }
          : undefined;

    createRoot(document.getElementById("root")).render(
      React.createElement(OnboardingRoot, {
        initialStateId: state,
        localDownloadProgress,
      }),
    );
  `;
}

function buildIndexHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>New Onboarding Review</title>
    <script>window.process = window.process || { env: {} };</script>
    <script type="module" src="/src/main.tsx"></script>
    <style>
      html, body, #root { width: 100%; height: 100%; margin: 0; }
      body { overflow: hidden; }
    </style>
  </head>
  <body><div id="root"></div></body>
</html>`;
}

async function startHarness(): Promise<{ server: ViteDevServer; url: string }> {
  const port = await getFreePort();
  const harnessRoot = path.join(outputRoot, "harness");
  await mkdir(path.join(harnessRoot, "src"), { recursive: true });
  await writeFile(path.join(harnessRoot, "index.html"), buildIndexHtml(), "utf-8");
  await writeFile(
    path.join(harnessRoot, "src/main.tsx"),
    buildHarnessSource(),
    "utf-8",
  );
  await writeFile(
    path.join(harnessRoot, "src/onboarding-mocks.tsx"),
    `
      import React from "react";
      export function BackgroundHost() {
        return React.createElement("div", {
          "aria-hidden": true,
          style: {
            position: "absolute",
            inset: 0,
            zIndex: 0,
            pointerEvents: "none",
            background: "linear-gradient(180deg, #1d91e8 0%, #f7a24a 100%)",
          },
        });
      }
      export function AvatarHost() {
        return React.createElement("div", {
          "aria-hidden": true,
          style: {
            width: "100%",
            height: "100%",
            borderRadius: 999,
            background: "radial-gradient(circle at 50% 45%, #fff 0 12%, #ff8a3d 13% 34%, transparent 35%)",
          },
        });
      }
    `,
    "utf-8",
  );
  const mockPath = path.join(harnessRoot, "src/onboarding-mocks.tsx");
  const server = await createViteServer({
    root: harnessRoot,
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: {
      port,
      host: "127.0.0.1",
      strictPort: true,
      fs: { allow: [repoRoot] },
      watch: {
        ignored: [
          `${outputRoot.replace(/\\/g, "/")}/**`,
          `${path.join(repoRoot, "android").replace(/\\/g, "/")}/**`,
          `${path.join(repoRoot, "ios").replace(/\\/g, "/")}/**`,
        ],
      },
    },
    resolve: {
      alias: [
        {
          find: new RegExp(
            `^${path.join(uiRoot, "src/backgrounds").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/index\\.ts)?$`,
          ),
          replacement: mockPath,
        },
        {
          find: new RegExp(
            `^${path.join(uiRoot, "src/avatar-runtime").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/index\\.ts)?$`,
          ),
          replacement: mockPath,
        },
        { find: /^@elizaos\/ui$/, replacement: path.join(uiRoot, "src/index.ts") },
        { find: /^@elizaos\/ui\/(.+)$/, replacement: path.join(uiRoot, "src/$1") },
      ],
    },
    plugins: [
      {
        name: "new-onboarding-review-mocks",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            importer?.includes("/packages/ui/src/components/onboarding/") &&
            (source.endsWith("backgrounds") ||
              source.endsWith("avatar-runtime"))
          ) {
            return mockPath;
          }
          return null;
        },
      },
    ],
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function waitForExpected(page: Page, state: StateSpec): Promise<void> {
  await page
    .locator(`[data-eliza-ob-state="${state.id}"]`)
    .waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
  for (const expected of state.expected) {
    await page.getByText(expected).first().waitFor({
      state: "visible",
      timeout: READY_TIMEOUT_MS,
    });
  }
}

async function waitForQuiet(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
}

function installNetworkTracker(page: Page): Set<Request> {
  const pending = new Set<Request>();
  page.on("request", (request) => pending.add(request));
  const clear = (request: Request) => pending.delete(request);
  page.on("requestfinished", clear);
  page.on("requestfailed", clear);
  return pending;
}

async function captureState(args: {
  context: BrowserContext;
  harnessUrl: string;
  state: StateSpec;
  viewport: ViewportSpec;
}): Promise<{ capture?: CaptureRecord; failure?: FailureRecord }> {
  let page: Page | null = null;
  const consoleLines: string[] = [];

  const slug = stateSlug(args.state);
  const filename = `${args.viewport.id}-${slug}.png`;
  const relativePath = `screenshots/${filename}`;
  const screenshotPath = path.join(screenshotsRoot, filename);
  const query = new URLSearchParams({
    state: args.state.id,
    ...(args.state.query ?? {}),
  });

  try {
    page = await args.context.newPage();
    const pendingRequests = installNetworkTracker(page);
    page.on("console", (message) => {
      consoleLines.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      consoleLines.push(`pageerror: ${error.stack ?? error.message}`);
    });
    await page.setViewportSize({
      width: args.viewport.width,
      height: args.viewport.height,
    });
    await page.goto(`${args.harnessUrl}/?${query.toString()}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForExpected(page, args.state);
    await waitForQuiet(page);

    const pending = Array.from(pendingRequests).filter(
      (request) => request.resourceType() !== "image",
    );
    if (pending.length > 0) {
      throw new Error(
        `Non-image network requests still pending: ${pending
          .map((request) => request.url())
          .join(", ")}`,
      );
    }

    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5000 });
    return {
      capture: {
        stateId: slug,
        stateLabel: args.state.label,
        viewportId: args.viewport.id,
        viewportLabel: args.viewport.label,
        viewportSize: `${args.viewport.width}x${args.viewport.height}`,
        relativePath,
      },
    };
  } catch (error) {
    await mkdir(diagnosticsRoot, { recursive: true });
    const failShot = path.join(diagnosticsRoot, `${args.viewport.id}-${slug}.png`);
    const consolePath = path.join(
      diagnosticsRoot,
      `${args.viewport.id}-${slug}.console.txt`,
    );
    await page
      ?.screenshot({ path: failShot, fullPage: true, timeout: 5000 })
      .catch(() => {});
    await writeFile(consolePath, consoleLines.join("\n"), "utf-8");
    return {
      failure: {
        stateId: slug,
        viewportId: args.viewport.id,
        message: error instanceof Error ? error.message : String(error),
        screenshotPath: path.relative(outputRoot, failShot),
        consolePath: path.relative(outputRoot, consolePath),
      },
    };
  } finally {
    await page?.close().catch(() => {});
  }
}

async function writeContactSheet(manifest: Manifest): Promise<void> {
  const rows = manifest.captures
    .map(
      (capture) => `
        <figure>
          <img src="${escapeHtml(capture.relativePath)}" alt="${escapeHtml(
            `${capture.viewportLabel} ${capture.stateLabel}`,
          )}" />
          <figcaption>
            <strong>${escapeHtml(capture.stateLabel)}</strong>
            <span>${escapeHtml(capture.viewportLabel)} · ${escapeHtml(
              capture.viewportSize,
            )}</span>
          </figcaption>
        </figure>`,
    )
    .join("\n");

  const failures = manifest.failures
    .map(
      (failure) => `
        <li>
          <strong>${escapeHtml(failure.viewportId)} ${escapeHtml(
            failure.stateId,
          )}</strong>: ${escapeHtml(failure.message)}
        </li>`,
    )
    .join("\n");

  await writeFile(
    path.join(outputRoot, "contact-sheet.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>New Onboarding Contact Sheet</title>
    <style>
      body { margin: 24px; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111; color: #f5f5f5; }
      header { margin-bottom: 20px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; align-items: start; }
      figure { margin: 0; border: 1px solid rgba(255,255,255,0.18); background: #1c1c1c; border-radius: 8px; overflow: hidden; }
      img { display: block; width: 100%; height: auto; background: #000; }
      figcaption { display: flex; justify-content: space-between; gap: 10px; padding: 10px 12px; font-size: 13px; }
      figcaption span { color: #bbb; }
      .failures { padding: 12px 16px; border: 1px solid #8b2d2d; background: #2a1111; border-radius: 8px; margin-bottom: 18px; }
    </style>
  </head>
  <body>
    <header>
      <h1>New Onboarding Contact Sheet</h1>
      <p>Generated ${escapeHtml(manifest.generatedAt)} from ${escapeHtml(
        manifest.harnessUrl,
      )}. ${manifest.captures.length} captures, ${manifest.failures.length} failures.</p>
    </header>
    ${
      manifest.failures.length
        ? `<section class="failures"><h2>Failures</h2><ul>${failures}</ul></section>`
        : ""
    }
    <main class="grid">${rows}</main>
  </body>
</html>`,
    "utf-8",
  );
}

async function main(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(screenshotsRoot, { recursive: true });

  const { server, url } = await startHarness();
  const captures: CaptureRecord[] = [];
  const failures: FailureRecord[] = [];

  try {
    for (const viewport of viewports) {
      const browser = await chromium.launch({
        headless: process.env.ELIZA_DESIGN_REVIEW_HEADLESS !== "0",
        args: ["--disable-gpu", "--disable-dev-shm-usage"],
      });
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
      });
      try {
        for (const state of states) {
          console.log(
            `[new-onboarding-review] capturing ${viewport.id}/${stateSlug(state)}`,
          );
          const result = await captureState({
            context,
            harnessUrl: url,
            state,
            viewport,
          });
          if (result.capture) captures.push(result.capture);
          if (result.failure) failures.push(result.failure);
        }
      } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      }
    }
  } finally {
    await server.close();
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    harnessUrl: url,
    captures,
    failures,
  };

  await writeFile(
    path.join(outputRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  await writeContactSheet(manifest);

  console.log(
    `[new-onboarding-review] wrote ${captures.length} screenshots to ${outputRoot}`,
  );
  if (failures.length > 0) {
    console.error(
      `[new-onboarding-review] ${failures.length} capture(s) failed; see manifest.json`,
    );
    process.exitCode = 1;
  }
}

await main();
