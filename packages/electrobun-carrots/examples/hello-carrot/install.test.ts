import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  installPrebuiltCarrot,
  loadInstalledCarrot,
} from "../../src/store.js";

const HELLO_CARROT_DIR = resolve(import.meta.dir);

describe("hello-carrot example", () => {
  it("manifest validates, installs, and wires bootstrap end-to-end", () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "hello-carrot-"));
    try {
      const installed = installPrebuiltCarrot(storeRoot, HELLO_CARROT_DIR, {
        devMode: true,
      });

      expect(installed.manifest.id).toBe("hello-carrot");
      expect(installed.manifest.mode).toBe("background");
      expect(existsSync(installed.workerPath)).toBe(true);
      expect(installed.workerPath).toContain(".bunny/carrot-bun-entrypoint.mjs");

      const bootstrap = readFileSync(installed.workerPath, "utf8");
      expect(bootstrap).toContain("__bunnyCarrotBootstrap");
      expect(bootstrap).toContain('"id":"hello-carrot"');
      expect(bootstrap).toContain('"channel":"carrot:hello-carrot"');
      expect(bootstrap).toContain("await import");

      const reloaded = loadInstalledCarrot(storeRoot, "hello-carrot");
      expect(reloaded).not.toBeNull();
      expect(reloaded?.viewUrl).toBe("views://view/index.html");
      expect(dirname(reloaded!.bundleWorkerPath)).toBe(installed.currentDir);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });
});
