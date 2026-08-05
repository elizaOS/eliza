/**
 * Exercises the Cloudflare Pages frontend freshness guard. The deployment
 * workflow needs a live custom-domain check because `wrangler pages deploy`
 * can succeed while the production domain still serves an older Vite entry
 * bundle, which leaves onboarding fixes absent from the user-facing app.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractEntryAssets,
  normalizeAssetPath,
  normalizeBaseUrl,
  verifyPagesFrontendOnce,
} from "../verify-pages-frontend.mjs";
import { parseArgs } from "../verify-pages-frontend-cli.mjs";

const tmpRoots: string[] = [];

function makeDist(asset = "assets/index-fresh.js") {
  const dir = mkdtempSync(join(tmpdir(), "pages-frontend-"));
  tmpRoots.push(dir);
  writeFileSync(
    join(dir, "index.html"),
    `<html><head><script type="module" src="/${asset}"></script></head></html>`,
  );
  return dir;
}

function response(body: string, ok = true, status = ok ? 200 : 500) {
  return { ok, status, text: async () => body };
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("extractEntryAssets", () => {
  it("extracts unique Vite entry script assets from HTML", () => {
    expect(
      extractEntryAssets(`
        <script type="module" src="/assets/index-a.js"></script>
        <link rel="modulepreload" href="./assets/index-b.js">
        <script src="/assets/chunk.js"></script>
        <script type="module" src="/assets/index-a.js"></script>
      `),
    ).toEqual(["assets/index-a.js", "assets/index-b.js"]);
  });

  it("ignores non-string input", () => {
    // @ts-expect-error deliberately wrong type
    expect(extractEntryAssets(null)).toEqual([]);
  });
});

describe("normalizers", () => {
  it("normalizes base URLs and asset paths", () => {
    expect(normalizeBaseUrl("https://app.elizacloud.ai")?.href).toBe(
      "https://app.elizacloud.ai/",
    );
    expect(normalizeBaseUrl("not a url")).toBeNull();
    expect(normalizeAssetPath("/assets/index-x.js")).toBe("assets/index-x.js");
    expect(
      normalizeAssetPath("https://app.elizacloud.ai/assets/index-x.js"),
    ).toBe("assets/index-x.js");
  });
});

describe("verifyPagesFrontendOnce", () => {
  const noSleep = async () => {};

  it("passes when the live index serves the local entry bundle with required text", async () => {
    const distDir = makeDist();
    const fetchImpl = (async (url: string) => {
      if (url === "https://app.elizacloud.ai/") {
        return response(
          '<script type="module" src="/assets/index-fresh.js"></script>',
        );
      }
      if (url === "https://app.elizacloud.ai/assets/index-fresh.js") {
        return response("Signing in to your agent\nCloudPairRelay");
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      requiredTexts: ["Signing in to your agent", "CloudPairRelay"],
      fetchImpl,
      retrySleep: noSleep,
    });

    expect(report.ok).toBe(true);
    expect(report.reason).toBe("ok");
  });

  it("fails when the custom domain still serves a stale entry bundle", async () => {
    const distDir = makeDist();
    const fetchImpl = (async () =>
      response(
        '<script type="module" src="/assets/index-stale.js"></script>',
      )) as unknown as typeof fetch;

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      fetchImpl,
      retrySleep: noSleep,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("stale_entry_asset");
    expect(report.detail).toContain("index-stale");
    expect(report.detail).toContain("index-fresh");
  });

  it("fails when the served entry bundle misses required onboarding text", async () => {
    const distDir = makeDist();
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/assets/index-fresh.js")) {
        return response("Sign in with your password");
      }
      return response(
        '<script type="module" src="/assets/index-fresh.js"></script>',
      );
    }) as unknown as typeof fetch;

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      requiredTexts: ["Signing in to your agent"],
      fetchImpl,
      retrySleep: noSleep,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("required_text_missing");
    expect(report.requiredTextResults).toEqual([
      { text: "Signing in to your agent", present: false },
    ]);
  });

  it("reports an unreachable live index", async () => {
    const distDir = makeDist();
    const fetchImpl = (async () =>
      response("bad gateway", false, 502)) as unknown as typeof fetch;

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      fetchImpl,
      fetchAttempts: 1,
      retrySleep: noSleep,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("index_unreachable");
    expect(report.detail).toContain("502");
  });
});

describe("parseArgs", () => {
  it("parses required text and retry flags", () => {
    expect(
      parseArgs([
        "--served-url",
        "https://app.elizacloud.ai",
        "--dist=packages/app/dist",
        "--require-text",
        "Signing in to your agent",
        "--require-text=CloudPairRelay",
        "--attempts",
        "9",
        "--interval-ms=250",
        "--json",
      ]),
    ).toEqual({
      servedUrl: "https://app.elizacloud.ai",
      distDir: "packages/app/dist",
      requiredTexts: ["Signing in to your agent", "CloudPairRelay"],
      attempts: 9,
      intervalMs: 250,
      json: true,
    });
  });
});
