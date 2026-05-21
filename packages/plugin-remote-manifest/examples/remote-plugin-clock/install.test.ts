import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installPrebuiltRemotePlugin, loadInstalledRemotePlugin } from "../../src/store.js";

const REMOTE_PLUGIN_CLOCK_DIR = resolve(import.meta.dir);

describe("remote-plugin-clock example", () => {
  it("installs as a window-mode remotePlugin with the expected view metadata", () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "remote-plugin-clock-"));
    try {
      const installed = installPrebuiltRemotePlugin(storeRoot, REMOTE_PLUGIN_CLOCK_DIR, {
        devMode: false,
      });

      expect(installed.manifest.id).toBe("remote-plugin-clock");
      expect(installed.manifest.mode).toBe("window");
      expect(installed.manifest.view.title).toBe("Remote Plugin Clock");
      expect(installed.manifest.view.width).toBe(320);
      expect(installed.manifest.view.height).toBe(200);
      expect(installed.manifest.view.titleBarStyle).toBe("default");

      const bootstrap = readFileSync(installed.workerPath, "utf8");
      expect(bootstrap).toContain('"id":"remote-plugin-clock"');
      expect(bootstrap).toContain('"mode":"window"');

      const reloaded = loadInstalledRemotePlugin(storeRoot, "remote-plugin-clock");
      expect(reloaded).not.toBeNull();
      expect(reloaded?.viewUrl).toBe("views://view/index.html");
      if (!reloaded) throw new Error("Expected remote-plugin-clock to reload.");
      expect(existsSync(reloaded.viewPath)).toBe(true);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });
});
