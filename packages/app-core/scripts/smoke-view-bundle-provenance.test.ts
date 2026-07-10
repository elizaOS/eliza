/**
 * End-to-end contract for the UI-smoke stub's view-bundle route: boots the real
 * stub server (no mocks) and asserts the provenance the stub actually emits over
 * HTTP. Proves that audit mode fails observably instead of fabricating a bundle
 * for a production-declared view, and that synthesized placeholders are marked
 * as such on the wire (issue #15791).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const stubPath = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "playwright-ui-smoke-api-stub.mjs",
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function bootStub(env: Record<string, string>): Promise<{
  child: ChildProcess;
  port: number;
}> {
  const port = await freePort();
  const child = spawn("node", [stubPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELIZA_UI_SMOKE_API_PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("stub did not start in time")),
      30_000,
    );
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`stub exited before ready (code ${code})`));
    });
  });
  return { child, port };
}

let running: ChildProcess | null = null;
const tempRoots: string[] = [];
afterEach(async () => {
  running?.kill("SIGKILL");
  running = null;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function emptyBundleRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eliza-view-bundles-"));
  tempRoots.push(root);
  return root;
}

async function bundleRootWithWallet(): Promise<string> {
  const root = await emptyBundleRoot();
  const bundleDir = path.join(root, "plugin-wallet-ui", "dist", "views");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(
    path.join(bundleDir, "bundle.js"),
    "export const InventoryView = () => null;\n",
    "utf8",
  );
  return root;
}

describe("smoke view bundle provenance over HTTP (#15791)", () => {
  it("audit mode returns an observable failure, never a fabricated bundle", async () => {
    const bundleRoot = await emptyBundleRoot();
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_REQUIRE_REAL_BUNDLES: "1",
      ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT: bundleRoot,
    });
    running = child;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/wallet/bundle.js`,
    );
    expect(response.headers.get("x-eliza-view-component")).toBe(
      "InventoryView",
    );
    expect(response.status).toBe(424);
    expect(response.headers.get("x-eliza-view-bundle-provenance")).toBe(
      "missing-real-bundle",
    );
    const body = await response.json();
    expect(body.provenance).toBe("missing-real-bundle");
    expect(body.expectedBundlePath).toContain(
      "plugins/plugin-wallet-ui/dist/views/bundle.js",
    );
  });

  it("non-audit marks synthesized placeholders on the wire and in bytes", async () => {
    const bundleRoot = await emptyBundleRoot();
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT: bundleRoot,
    });
    running = child;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/wallet/bundle.js`,
    );
    expect(response.status).toBe(200);
    // The component name is echoed so an audit asserts the RIGHT component's
    // surface rendered — a route cannot silently pass against the wrong one.
    expect(response.headers.get("x-eliza-view-component")).toBe(
      "InventoryView",
    );
    const provenance = response.headers.get("x-eliza-view-bundle-provenance");
    const body = await response.text();
    expect(provenance).toBe("synthesized-generic");
    expect(body).toContain("eliza-view-bundle-provenance: synthesized-generic");
    expect(body).toContain("InventoryView");
  });

  it("audit mode serves a present real bundle with exact identity headers", async () => {
    const bundleRoot = await bundleRootWithWallet();
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_REQUIRE_REAL_BUNDLES: "1",
      ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT: bundleRoot,
    });
    running = child;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/wallet/bundle.js`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-eliza-view-bundle-provenance")).toBe(
      "real-dist",
    );
    expect(response.headers.get("x-eliza-view-component")).toBe(
      "InventoryView",
    );
    expect(response.headers.get("x-eliza-view-id")).toBe("wallet");
    expect(await response.text()).toContain("export const InventoryView");
  });
});
