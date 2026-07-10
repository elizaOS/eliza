/**
 * End-to-end contract for the UI-smoke stub's view-bundle route: boots the real
 * stub server (no mocks) and asserts the provenance the stub actually emits over
 * HTTP. Proves that audit mode fails observably instead of fabricating a bundle
 * for a production-declared view, and that synthesized placeholders are marked
 * as such on the wire (issue #15791).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { realViewBundleExists } from "./smoke-view-declarations.mjs";

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
afterEach(() => {
  running?.kill("SIGKILL");
  running = null;
});

describe("smoke view bundle provenance over HTTP (#15791)", () => {
  // Whether a real dist bundle exists depends on prior builds; the provenance
  // contract must hold in either state, so the expectations branch on it.
  const walletHasRealBundle = realViewBundleExists(
    repoRoot,
    "plugin-wallet-ui",
  );

  it("audit mode returns an observable failure, never a fabricated bundle", async () => {
    const { child, port } = await bootStub({
      ELIZA_UI_SMOKE_REQUIRE_REAL_BUNDLES: "1",
    });
    running = child;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/views/wallet/bundle.js`,
    );
    expect(response.headers.get("x-eliza-view-component")).toBe(
      "InventoryView",
    );
    if (walletHasRealBundle) {
      // A real bundle is present: audit mode must serve it, marked real-dist.
      expect(response.status).toBe(200);
      expect(response.headers.get("x-eliza-view-bundle-provenance")).toBe(
        "real-dist",
      );
      return;
    }
    // No real bundle: audit mode refuses to fabricate one and fails observably.
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
    const { child, port } = await bootStub({});
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
    if (walletHasRealBundle) {
      expect(provenance).toBe("real-dist");
      return;
    }
    expect(provenance).toBe("synthesized-generic");
    expect(body).toContain("eliza-view-bundle-provenance: synthesized-generic");
    expect(body).toContain("InventoryView");
  });
});
