/**
 * Exercises the Cloudflare Pages frontend freshness guard. The deployment
 * workflow needs a live custom-domain check because `wrangler pages deploy`
 * can succeed while the production domain still serves an older Vite entry
 * bundle, which leaves onboarding fixes absent from the user-facing app.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
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

function makeDist(
  asset = "assets/index-fresh.js",
  contents = "Signing in to your agent\nCloudPairRelay",
) {
  const dir = mkdtempSync(join(tmpdir(), "pages-frontend-"));
  tmpRoots.push(dir);
  writeFileSync(
    join(dir, "index.html"),
    `<html><head><script type="module" src="/${asset}"></script></head></html>`,
  );
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, asset), contents);
  return dir;
}

function response(body: string, ok = true, status = ok ? 200 : 500) {
  const bytes = new TextEncoder().encode(body);
  return { ok, status, arrayBuffer: async () => bytes.buffer };
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
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("stale_entry_asset");
    expect(report.detail).toContain("index-stale");
    expect(report.detail).toContain("index-fresh");
  });

  it("fails when the served entry bundle misses required onboarding text", async () => {
    const distDir = makeDist(
      "assets/index-fresh.js",
      "Sign in with your password",
    );
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
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("required_text_missing");
    expect(report.requiredTextResults).toEqual([
      { text: "Signing in to your agent", present: false },
    ]);
  });

  it("searches required text in lazy JavaScript while proving every emitted asset", async () => {
    const entry = 'import("./AppContext-lazy.js");';
    const lazy =
      "Signing in to your agent\nThis tab will continue automatically";
    const distDir = makeDist("assets/index-fresh.js", entry);
    writeFileSync(join(distDir, "assets/AppContext-lazy.js"), lazy);
    const fetchImpl = (async (url: string) => {
      if (url === "https://app.elizacloud.ai/") {
        return response(
          '<script type="module" src="/assets/index-fresh.js"></script>',
        );
      }
      if (url.endsWith("/assets/index-fresh.js")) return response(entry);
      if (url.endsWith("/assets/AppContext-lazy.js")) return response(lazy);
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      requiredTexts: [
        "Signing in to your agent",
        "This tab will continue automatically",
      ],
      fetchImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.detail).toContain("2 emitted JavaScript asset(s)");
  });

  it("fails when a live lazy asset does not exactly match local bytes", async () => {
    const distDir = makeDist("assets/index-fresh.js", "entry");
    writeFileSync(join(distDir, "assets/AppContext-lazy.js"), "local lazy");
    const fetchImpl = (async (url: string) => {
      if (url === "https://app.elizacloud.ai/") {
        return response(
          '<script type="module" src="/assets/index-fresh.js"></script>',
        );
      }
      if (url.endsWith("/assets/index-fresh.js")) return response("entry");
      if (url.endsWith("/assets/AppContext-lazy.js")) {
        return response("different live lazy");
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("asset_bytes_mismatch");
    expect(report.detail).toContain("assets/AppContext-lazy.js");
  });

  it("fails when a public-root service worker is stale", async () => {
    const distDir = makeDist("assets/index-fresh.js", "entry");
    writeFileSync(join(distDir, "sw.js"), 'const BUILD_REV = "fresh";');
    const fetchImpl = (async (url: string) => {
      if (url === "https://app.elizacloud.ai/") {
        return response(
          '<script type="module" src="/assets/index-fresh.js"></script>',
        );
      }
      if (url.endsWith("/assets/index-fresh.js")) return response("entry");
      if (url.endsWith("/sw.js")) {
        return response('const BUILD_REV = "stale";');
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("asset_bytes_mismatch");
    expect(report.detail).toContain("sw.js");
  });

  it("returns a structured timeout when a live asset body never settles", async () => {
    const distDir = makeDist("assets/index-fresh.js", "entry");
    const fetchImpl = ((url: string) => {
      if (url === "https://app.elizacloud.ai/") {
        return Promise.resolve(
          response(
            '<script type="module" src="/assets/index-fresh.js"></script>',
          ),
        );
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => new Promise(() => {}),
      });
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      fetchImpl,
      verificationTimeoutMs: 30,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("verification_timeout");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("cancels a hanging sibling when another asset fails", async () => {
    const distDir = makeDist("assets/index-fresh.js", "entry");
    writeFileSync(join(distDir, "assets/a-fail.js"), "bad");
    writeFileSync(join(distDir, "assets/b-hang.js"), "hang");
    const fetchImpl = ((url: string) => {
      if (url === "https://app.elizacloud.ai/") {
        return Promise.resolve(
          response(
            '<script type="module" src="/assets/index-fresh.js"></script>',
          ),
        );
      }
      if (url.endsWith("/a-fail.js"))
        return Promise.resolve(response("", false, 404));
      if (url.endsWith("/b-hang.js")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => new Promise(() => {}),
        });
      }
      if (url.endsWith("/assets/index-fresh.js"))
        return Promise.resolve(response("entry"));
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      fetchImpl,
      fetchTimeoutMs: 1_000,
      verificationTimeoutMs: 2_000,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("javascript_asset_unreachable");
    expect(report.detail).toContain("assets/a-fail.js");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("rejects an emitted JavaScript graph above its byte budget", async () => {
    const distDir = makeDist("assets/index-fresh.js", "entry");
    const oversizedAsset = join(distDir, "assets/oversized.js");
    writeFileSync(oversizedAsset, "");
    truncateSync(oversizedAsset, 128 * 1024 * 1024 + 1);

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      fetchImpl: (async () => {
        throw new Error("asset budget must fail before network access");
      }) as unknown as typeof fetch,
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toBe("asset_budget_exceeded");
    expect(report.detail).toContain("134217728 bytes");
  });

  it("reports an unreachable live index", async () => {
    const distDir = makeDist();
    const fetchImpl = (async () =>
      response("bad gateway", false, 502)) as unknown as typeof fetch;

    const report = await verifyPagesFrontendOnce({
      servedUrl: "https://app.elizacloud.ai",
      distDir,
      fetchImpl,
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
