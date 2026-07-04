/**
 * Manifest validation tests exercise JSON-like input parsing and issue
 * reporting for remote plugin manifests received at install boundaries.
 */
import { describe, expect, it } from "bun:test";
import { validateRemotePluginManifest } from "./validation.js";

describe("remote plugin manifest validation", () => {
  it("validates and normalizes a manifest", () => {
    const result = validateRemotePluginManifest({
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
    const result = validateRemotePluginManifest({
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

  it("rejects ids that could escape the remote plugin store root", () => {
    const result = validateRemotePluginManifest({
      id: "../../outside",
      name: "Dash",
      version: "0.1.0",
      description: "IDE",
      mode: "window",
      permissions: {},
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
    expect(result.issues.map((issue) => issue.path)).toContain("$.id");
  });

  it("rejects malformed optional manifest sections", () => {
    const result = validateRemotePluginManifest({
      id: "bunny.dash",
      name: "Dash",
      version: "0.1.0",
      description: "IDE",
      mode: "window",
      dependencies: {
        "bunny.git": 1,
      },
      permissions: {},
      view: {
        relativePath: "views/main/index.html",
        title: "Dash",
        width: 1200,
        height: 800,
        hidden: "false",
        transparent: "true",
        titleBarStyle: "floating",
      },
      worker: { relativePath: "" },
      remoteUIs: {
        dash: { name: "Dash" },
        broken: "remote-ui/broken/index.html",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "view.titleBarStyle",
      "view.hidden",
      "view.transparent",
      "worker.relativePath",
      "dependencies.bunny.git",
      "remoteUIs.dash.path",
      "remoteUIs.broken",
    ]);
  });
});
