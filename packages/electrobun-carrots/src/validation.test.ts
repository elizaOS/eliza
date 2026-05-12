import { describe, expect, it } from "bun:test";
import { validateCarrotManifest } from "./validation.js";

describe("carrot manifest validation", () => {
  it("validates and normalizes a manifest", () => {
    const result = validateCarrotManifest({
      id: "bunny.dash",
      name: "Dash",
      version: "0.1.0",
      description: "IDE",
      mode: "window",
      dependencies: { "bunny.git": "file:../git" },
      permissions: {
        host: { windows: true, storage: true },
        bun: { read: true, write: true, run: true },
      },
      view: {
        relativePath: "views/main/index.html",
        title: "Dash",
        width: 1200,
        height: 800,
        hidden: false,
        titleBarStyle: "default",
      },
      worker: { relativePath: "worker.js" },
      remoteUIs: {
        dash: { name: "Dash", path: "lens/index.html" },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.permissions.isolation).toBe("shared-worker");
    expect(result.manifest.dependencies).toEqual({
      "bunny.git": "file:../git",
    });
    expect(result.manifest.remoteUIs?.dash).toEqual({
      name: "Dash",
      path: "lens/index.html",
    });
  });

  it("rejects malformed permissions and required fields", () => {
    const result = validateCarrotManifest({
      id: "",
      name: "Dash",
      version: "0.1.0",
      description: "IDE",
      mode: "window",
      permissions: {
        host: { camera: true },
        bun: { read: "yes" },
        isolation: "process",
      },
      view: {
        relativePath: "views/main/index.html",
        title: "Dash",
        width: 1200,
        height: 800,
      },
      worker: { relativePath: "worker.js" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "$.id",
      "permissions.host.camera",
      "permissions.bun.read",
      "permissions.isolation",
    ]);
  });
});
