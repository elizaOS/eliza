import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = new URL("../src/android/shutdown.ts", import.meta.url).href;

for (const mode of ["success", "failure", "hang"] as const) {
  test(`Android CLI shutdown ${mode} exits with an otherwise live timer`, () => {
    const directory = mkdtempSync(join(tmpdir(), "android-shutdown-"));
    try {
      const childPath = join(directory, "child.ts");
      writeFileSync(
        childPath,
        `
import { createServer } from "node:net";
import { writeSync } from "node:fs";
import { shutdownAndroidBridge } from ${JSON.stringify(helper)};
const mode = ${JSON.stringify(mode)};
const mark = (message: string) => writeSync(1, message + "\\n");
const server = createServer();
server.listen(0, "127.0.0.1", async () => {
  setInterval(() => {}, 1000);
  mark("live-timer");
  await shutdownAndroidBridge(() => {
    mark("ingress-close");
    return new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }, {
    async stop() {
      mark("runtime-stop");
      if (mode === "failure") throw Error("synthetic-private-diagnostic");
      if (mode === "hang") await new Promise(() => {});
    },
    async close() { mark("storage-close"); },
  }, mark);
});
`,
      );
      const result = spawnSync(process.execPath, [childPath], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16_384,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(mode === "success" ? 0 : 1);
      expect(result.stderr).toBe("");
      const lines = result.stdout.trim().split("\n");
      expect(lines.slice(0, 3)).toEqual([
        "live-timer",
        "ingress-close",
        "runtime-stop",
      ]);
      expect(result.stdout).not.toContain("synthetic-private-diagnostic");
      if (mode === "success") {
        expect(lines.slice(3)).toEqual([
          "storage-close",
          "[android-bridge] runtime and socket shutdown complete",
        ]);
      } else {
        expect(lines).not.toContain("storage-close");
        expect(lines.at(-1)).toBe(
          mode === "hang"
            ? "[android-bridge] graceful shutdown deadline exceeded"
            : "[android-bridge] graceful shutdown failed",
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
