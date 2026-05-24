/**
 * Cloud-background review runner.
 *
 * Boots a tiny Vite harness that mounts the REAL `CloudVideoBackground`
 * (poster-first, then the streamed HQ cloud loop) full-screen, with the
 * onboarding and home surfaces layered above it in Z — exactly how the app
 * stacks them. Serves the synced brand assets from `packages/app/public` so
 * the real `clouds_background.jpg` + `Clouds_Loop_HQ_1080p.mp4` are used.
 *
 * Captures, per scene × viewport:
 *   - `<scene>-poster.png`  the immediate jpeg-first paint
 *   - `<scene>-video.png`   after the cloud loop has streamed in
 * and records a short video of the onboarding→home transition.
 *
 * Output: packages/app/test-results/design-review/clouds/
 *
 * Usage:
 *   bunx tsx packages/app/test/design-review/run-clouds-review.ts
 *   ELIZA_DESIGN_REVIEW_HEADLESS=0 bunx tsx packages/app/test/design-review/run-clouds-review.ts
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { getFreePort } from "../utils/get-free-port.mjs";

type ViewportId = "desktop" | "mobile";
type SceneId = "onboarding" | "home";

interface ViewportSpec {
  id: ViewportId;
  width: number;
  height: number;
  isMobile: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(appRoot, "../..");
const uiRoot = path.join(repoRoot, "packages/ui");
const sharedRoot = path.join(repoRoot, "packages/shared");
const publicDir = path.join(appRoot, "public");
const outputRoot = path.resolve(appRoot, "test-results/design-review/clouds");
const screenshotsRoot = path.join(outputRoot, "screenshots");
const videoRoot = path.join(outputRoot, "video");

const viewports: ViewportSpec[] = [
  { id: "desktop", width: 1440, height: 900, isMobile: false },
  { id: "mobile", width: 390, height: 844, isMobile: true },
];

function buildHarnessMain(): string {
  const cloudPath = path
    .join(uiRoot, "src/backgrounds/CloudVideoBackground.tsx")
    .replace(/\\/g, "/");
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { CloudVideoBackground } from "/@fs/${cloudPath}";

    const params = new URLSearchParams(window.location.search);
    const scene = params.get("scene") || "onboarding";

    const glass = {
      background: "rgba(255,255,255,0.36)",
      backdropFilter: "blur(18px)",
      WebkitBackdropFilter: "blur(18px)",
      borderRadius: 4,
      color: "rgba(9,14,22,0.96)",
      fontFamily: "Poppins, system-ui, Arial, sans-serif",
    };

    function OptionCard({ title, body }) {
      return React.createElement("div", {
        style: { ...glass, padding: "18px 20px", textAlign: "left", width: "100%" },
      }, [
        React.createElement("div", { key: "t", style: { fontSize: 15, fontWeight: 600 } }, title),
        React.createElement("div", { key: "b", style: { fontSize: 13, opacity: 0.8, marginTop: 6 } }, body),
      ]);
    }

    function Onboarding() {
      return React.createElement("div", {
        style: { minHeight: "100%", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "64px 16px" },
      },
        React.createElement("div", {
          style: { ...glass, width: "100%", maxWidth: 460, padding: "32px 28px", display: "flex", flexDirection: "column", gap: 18 },
        }, [
          React.createElement("div", { key: "eyebrow", style: { textAlign: "center", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", opacity: 0.7 } }, "Welcome"),
          React.createElement("div", { key: "title", style: { textAlign: "center", fontSize: 22, fontWeight: 300 } }, "Set up your Eliza"),
          React.createElement("div", { key: "desc", style: { textAlign: "center", fontSize: 13, opacity: 0.82, marginBottom: 6 } }, "Run in the cloud, or fully on-device. You can change this later."),
          React.createElement(OptionCard, { key: "c1", title: "Eliza Cloud", body: "Hosted inference, services and sync. Best for getting started fast." }),
          React.createElement(OptionCard, { key: "c2", title: "On-device", body: "Everything local. Private by default; downloads the local model." }),
          React.createElement("button", {
            key: "cta",
            style: { marginTop: 8, height: 48, border: "none", borderRadius: 4, background: "rgba(255,88,0,0.92)", color: "#1c1008", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", fontSize: 13, cursor: "pointer" },
          }, "Continue"),
        ])
      );
    }

    function Home() {
      return React.createElement("div", {
        style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 16px", gap: 20 },
      }, [
        React.createElement("div", {
          key: "wave",
          style: { width: 240, height: 240, borderRadius: "50%", background: "radial-gradient(circle at 50% 45%, rgba(255,255,255,0.92) 0 16%, rgba(255,138,61,0.55) 24% 52%, transparent 60%)", boxShadow: "0 0 80px rgba(255,255,255,0.35)" },
        }),
        React.createElement("div", { key: "transcript", style: { fontSize: 14, color: "rgba(20,28,40,0.85)", fontFamily: "Poppins, system-ui, sans-serif" } }, "How can I help?"),
        React.createElement("div", {
          key: "composer",
          style: { display: "flex", alignItems: "center", gap: 8, width: "100%", maxWidth: 560, padding: 8, borderRadius: 999, background: "rgba(255,255,255,0.6)", backdropFilter: "blur(12px)", boxShadow: "0 10px 30px rgba(0,0,0,0.18)" },
        }, [
          React.createElement("div", { key: "input", style: { flex: 1, padding: "0 14px", color: "#475569", fontSize: 14, fontFamily: "Poppins, system-ui, sans-serif" } }, "Ask Eliza..."),
          React.createElement("div", { key: "mic", style: { width: 40, height: 40, borderRadius: "50%", display: "grid", placeItems: "center", color: "#64748b" } }, "\\u25CF"),
          React.createElement("div", { key: "send", style: { width: 40, height: 40, borderRadius: "50%", background: "rgba(255,88,0,0.92)", display: "grid", placeItems: "center", color: "#fff" } }, "\\u2191"),
        ]),
      ]);
    }

    createRoot(document.getElementById("root")).render(
      React.createElement(CloudVideoBackground, {
        scrim: scene === "onboarding" ? 0.05 : 0.08,
        style: { position: "fixed", inset: 0 },
      }, scene === "home" ? React.createElement(Home) : React.createElement(Onboarding))
    );
  `;
}

function indexHtml(): string {
  return `<!doctype html><html><head><meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Clouds Review</title>
    <style>html,body,#root{width:100%;height:100%;margin:0;}body{overflow:hidden;}</style>
    <script type="module" src="/src/main.tsx"></script>
  </head><body><div id="root"></div></body></html>`;
}

async function startHarness(): Promise<{ server: ViteDevServer; url: string }> {
  const port = await getFreePort();
  const harnessRoot = path.join(outputRoot, "harness");
  await mkdir(path.join(harnessRoot, "src"), { recursive: true });
  await writeFile(path.join(harnessRoot, "index.html"), indexHtml(), "utf-8");
  await writeFile(
    path.join(harnessRoot, "src/main.tsx"),
    buildHarnessMain(),
    "utf-8",
  );
  const server = await createViteServer({
    root: harnessRoot,
    publicDir,
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: {
      port,
      host: "127.0.0.1",
      strictPort: true,
      fs: { allow: [repoRoot] },
    },
    resolve: {
      alias: [
        {
          find: /^@elizaos\/shared\/brand$/,
          replacement: path.join(sharedRoot, "src/brand/index.ts"),
        },
      ],
    },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(screenshotsRoot, `${name}.png`),
    fullPage: false,
  });
}

async function main(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(screenshotsRoot, { recursive: true });
  await mkdir(videoRoot, { recursive: true });

  const { server, url } = await startHarness();
  const browser = await chromium.launch({
    headless: process.env.ELIZA_DESIGN_REVIEW_HEADLESS !== "0",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    for (const vp of viewports) {
      // Record a transition video for this viewport.
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        recordVideo: { dir: videoRoot, size: { width: vp.width, height: vp.height } },
      });
      const page = await context.newPage();

      for (const scene of ["onboarding", "home"] as SceneId[]) {
        await page.goto(`${url}/?scene=${scene}`, {
          waitUntil: "domcontentloaded",
        });
        // jpeg-first paint
        await page.waitForTimeout(150);
        await capture(page, `${vp.id}-${scene}-poster`);
        // Wait for the cloud loop to stream in + start playing, then capture.
        await page
          .waitForFunction(
            () => {
              const v = document.querySelector("video");
              return Boolean(v && v.readyState >= 2 && v.currentTime > 0);
            },
            { timeout: 9000 },
          )
          .catch(() => {});
        await page.waitForTimeout(900);
        await capture(page, `${vp.id}-${scene}-video`);
      }

      await page.close();
      const video = page.video();
      await context.close();
      if (video) {
        const saved = await video.path();
        await rm(path.join(videoRoot, `${vp.id}-onboarding-to-home.webm`), {
          force: true,
        }).catch(() => {});
        const fs = await import("node:fs/promises");
        await fs.rename(
          saved,
          path.join(videoRoot, `${vp.id}-onboarding-to-home.webm`),
        );
      }
      console.log(`[clouds-review] captured ${vp.id}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }

  console.log(`[clouds-review] output: ${outputRoot}`);
}

await main();
