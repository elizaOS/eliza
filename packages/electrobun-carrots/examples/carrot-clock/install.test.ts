import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installPrebuiltCarrot, loadInstalledCarrot } from "../../src/store.js";

const CARROT_CLOCK_DIR = resolve(import.meta.dir);

describe("carrot-clock example", () => {
  it("installs as a window-mode carrot with the expected view metadata", () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "carrot-clock-"));
    try {
      const installed = installPrebuiltCarrot(storeRoot, CARROT_CLOCK_DIR, {
        devMode: false,
      });

      expect(installed.manifest.id).toBe("carrot-clock");
      expect(installed.manifest.mode).toBe("window");
      expect(installed.manifest.view.title).toBe("Carrot Clock");
      expect(installed.manifest.view.width).toBe(320);
      expect(installed.manifest.view.height).toBe(200);
      expect(installed.manifest.view.titleBarStyle).toBe("default");

      const bootstrap = readFileSync(installed.workerPath, "utf8");
      expect(bootstrap).toContain('"id":"carrot-clock"');
      expect(bootstrap).toContain('"mode":"window"');

      const reloaded = loadInstalledCarrot(storeRoot, "carrot-clock");
      expect(reloaded).not.toBeNull();
      expect(reloaded?.viewUrl).toBe("views://view/index.html");
      expect(existsSync(reloaded!.viewPath)).toBe(true);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });
});
