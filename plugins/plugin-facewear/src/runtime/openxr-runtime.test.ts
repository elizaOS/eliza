/**
 * OpenXR runtime tests exercise detection and install planning through an
 * in-memory platform probe.
 */
import { describe, expect, it } from "vitest";
import {
  detectOpenXrRuntime,
  identifyRuntime,
  parseActiveRuntime,
  planOpenXrInstall,
  type RuntimeProbe,
} from "./openxr-runtime.ts";

/** In-memory filesystem and platform probe for deterministic runtime detection. */
function fakeProbe(opts: {
  platform: string;
  files?: Record<string, string>;
  env?: Record<string, string>;
  commands?: string[];
  registry?: Record<string, string>;
  home?: string;
}): RuntimeProbe {
  const files = opts.files ?? {};
  const env = opts.env ?? {};
  const commands = new Set(opts.commands ?? []);
  const registry = opts.registry ?? {};
  return {
    platform: () => opts.platform,
    env: (k) => env[k],
    homedir: () => opts.home ?? "/home/u",
    fileExists: (p) => Object.hasOwn(files, p),
    readFile: (p) => (Object.hasOwn(files, p) ? files[p] : null),
    which: (c) => (commands.has(c) ? `/usr/bin/${c}` : null),
    regQuery: (key, value) => registry[`${key}\\${value}`] ?? null,
  };
}

const MONADO_JSON = JSON.stringify({
  file_format_version: "1.0.0",
  runtime: { library_path: "/usr/lib/x86_64-linux-gnu/libopenxr_monado.so" },
});

describe("detectOpenXrRuntime — Linux", () => {
  it("finds an active Monado runtime in the XDG user path", () => {
    const probe = fakeProbe({
      platform: "linux",
      home: "/home/u",
      files: {
        "/home/u/.config/openxr/1/active_runtime.json": MONADO_JSON,
        "/usr/lib/x86_64-linux-gnu/libopenxr_monado.so": "",
      },
    });
    const status = detectOpenXrRuntime(probe);
    expect(status.installed).toBe(true);
    expect(status.runtime).toBe("monado");
    expect(status.source).toBe("xdg-user");
    expect(status.webxrReady).toBe(true);
  });

  it("honours XR_RUNTIME_JSON over the default search path", () => {
    const probe = fakeProbe({
      platform: "linux",
      env: { XR_RUNTIME_JSON: "/opt/steamvr/steamxr.json" },
      files: {
        "/opt/steamvr/steamxr.json": JSON.stringify({
          runtime: { library_path: "/opt/steamvr/bin/steamxr.so" },
        }),
        "/opt/steamvr/bin/steamxr.so": "",
      },
    });
    const status = detectOpenXrRuntime(probe);
    expect(status.installed).toBe(true);
    expect(status.runtime).toBe("steamvr");
    expect(status.source).toBe("XR_RUNTIME_JSON");
  });

  it("treats an active_runtime pointing at a missing library as stale (not installed)", () => {
    const probe = fakeProbe({
      platform: "linux",
      home: "/home/u",
      files: { "/home/u/.config/openxr/1/active_runtime.json": MONADO_JSON },
      // library file intentionally absent
    });
    const status = detectOpenXrRuntime(probe);
    expect(status.installed).toBe(false);
    expect(status.notes.join(" ")).toMatch(/stale/);
  });

  it("reports not-installed with a Monado-led plan when nothing is active", () => {
    const probe = fakeProbe({ platform: "linux" });
    const status = detectOpenXrRuntime(probe);
    expect(status.installed).toBe(false);
    expect(status.webxrReady).toBe(true);
    const plan = planOpenXrInstall(status);
    expect(plan.satisfied).toBe(false);
    expect(plan.runtime).toBe("monado");
    expect(plan.steps.map((s) => s.id)).toEqual([
      "steamvr",
      "monado-apt",
      "monado-activate",
    ]);
    // The apt step is the only privileged one.
    expect(plan.steps.filter((s) => s.privileged).map((s) => s.id)).toEqual([
      "monado-apt",
    ]);
  });
});

describe("detectOpenXrRuntime — Windows", () => {
  it("reads the active runtime from the Khronos registry key", () => {
    const probe = fakeProbe({
      platform: "win32",
      registry: {
        "HKLM\\SOFTWARE\\Khronos\\OpenXR\\1\\ActiveRuntime":
          "C:/SteamVR/steamxr_win64.json",
      },
      files: {
        "C:/SteamVR/steamxr_win64.json": JSON.stringify({
          runtime: { library_path: "steamvr/bin/steamxr.dll", name: "SteamVR" },
        }),
      },
    });
    const status = detectOpenXrRuntime(probe);
    expect(status.installed).toBe(true);
    expect(status.runtime).toBe("steamvr");
    expect(status.source).toBe("registry");
  });

  it("plans SteamVR + WMR when no runtime is registered", () => {
    const status = detectOpenXrRuntime(fakeProbe({ platform: "win32" }));
    expect(status.installed).toBe(false);
    const plan = planOpenXrInstall(status);
    expect(plan.steps.map((s) => s.id)).toEqual(["steamvr", "wmr"]);
    expect(plan.steps.every((s) => !s.privileged)).toBe(true);
  });
});

describe("detectOpenXrRuntime — macOS", () => {
  it("reports native WebXR with nothing to install", () => {
    const status = detectOpenXrRuntime(fakeProbe({ platform: "darwin" }));
    expect(status.installed).toBe(false);
    expect(status.webxrReady).toBe(false);
    expect(planOpenXrInstall(status).satisfied).toBe(true);
  });
});

describe("parseActiveRuntime + identifyRuntime", () => {
  it("extracts the library path and tolerates malformed json", () => {
    expect(parseActiveRuntime(MONADO_JSON)?.libraryPath).toContain("monado");
    expect(parseActiveRuntime("{ not json")).toBeNull();
    expect(parseActiveRuntime(JSON.stringify({ runtime: {} }))).toBeNull();
  });

  it("identifies runtimes by library path / name", () => {
    expect(identifyRuntime("/x/libopenxr_monado.so")).toBe("monado");
    expect(identifyRuntime("steamxr_win64.dll")).toBe("steamvr");
    expect(identifyRuntime("x", "Windows MixedReality Runtime")).toBe("wmr");
    expect(identifyRuntime("/x/oculus.json")).toBe("oculus");
    expect(identifyRuntime("/x/unknown.so")).toBe("unknown");
  });
});
