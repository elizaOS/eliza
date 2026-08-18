/** Verifies that app-core dev hosts never let runtime children mutate dependencies. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

describe.each([
  [
    "dev-platform",
    path.join(scriptsDir, "dev-platform.mjs"),
    'const apiSourceConditionArgs = ["--no-install", "--conditions=eliza-source"];',
  ],
  [
    "dev-ui",
    path.join(scriptsDir, "dev-ui.mjs"),
    '...(apiRuntimeIsBun ? ["--no-install"] : []),',
  ],
])("%s API child command", (_name, scriptPath, noInstallSource) => {
  it("disables Bun auto-install for the runtime process", () => {
    const source = readFileSync(scriptPath, "utf8");

    expect(source).toContain(noInstallSource);
    expect(source).toContain('"--conditions=eliza-source"');
  });
});

describe("dev-ui Vite runtime", () => {
  it("keeps renderer-only mobile topology out of the host API child", () => {
    const source = readFileSync(path.join(scriptsDir, "dev-ui.mjs"), "utf8");
    const viteEnv = source.indexOf(
      "function startVite() {\n  const childEnv = createDevChildEnv(process.env);",
    );
    const apiEnv = source.indexOf(
      "const childEnv = createApiChildEnv(process.env);",
      viteEnv + 1,
    );

    expect(source).toContain('"VITE_ELIZA_IOS_RUNTIME_MODE"');
    expect(source).toContain('"VITE_ELIZA_MOBILE_RUNTIME_MODE"');
    expect(viteEnv).toBeGreaterThan(-1);
    expect(apiEnv).toBeGreaterThan(viteEnv);
  });

  it("uses the validated package-manager Node instead of a PATH shim", () => {
    const source = readFileSync(path.join(scriptsDir, "dev-ui.mjs"), "utf8");

    expect(source).toContain("nodePath: resolveNodeRuntimePath(process.env)");
    expect(source).not.toContain('nodePath: which("node")');
  });

  it("starts Vite before watcher setup and API readiness polling", () => {
    const source = readFileSync(path.join(scriptsDir, "dev-ui.mjs"), "utf8");
    const apiStart = source.indexOf("  apiSupervisor.start();");
    const viteStart = source.indexOf("\n  startVite();", apiStart);
    const watcherStart = source.indexOf(
      "\n    sourceWatcher = startAgentSourceWatcher(",
      viteStart,
    );
    const readinessPoll = source.indexOf(
      "\n  waitForPort(API_PORT)",
      viteStart,
    );

    expect(apiStart).toBeGreaterThan(-1);
    expect(viteStart).toBeGreaterThan(apiStart);
    expect(watcherStart).toBeGreaterThan(viteStart);
    expect(readinessPoll).toBeGreaterThan(viteStart);
  });

  it("stops the startup watchdog after Vite first becomes ready", () => {
    const source = readFileSync(path.join(scriptsDir, "dev-ui.mjs"), "utf8");

    expect(source).toContain("viteReady = true;");
    expect(source).toContain(
      "if (shuttingDown || !viteProcess || viteReady) return;",
    );
    expect(source).toContain("if (!viteReady) scheduleViteHealthCheck();");
  });

  it("defers optional vision dependency work until after UI readiness", () => {
    const source = readFileSync(path.join(scriptsDir, "dev-ui.mjs"), "utf8");
    const readyState = source.indexOf("viteReady = true;");
    const visionStart = source.indexOf(
      "\n      startVisionDepsCheck();",
      readyState,
    );

    expect(readyState).toBeGreaterThan(-1);
    expect(visionStart).toBeGreaterThan(readyState);
    expect(source.slice(0, readyState)).not.toContain(
      "\nstartVisionDepsCheck();",
    );
  });
});
