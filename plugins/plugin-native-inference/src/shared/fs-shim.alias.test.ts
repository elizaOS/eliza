/**
 * Android /data/data ↔ /data/user/0 alias handling in the mobile fs sandbox.
 * The pure mapper is exercised in-process; the shim's accept/reject behavior
 * is proven against the REAL installMobileFsShim in a Bun subprocess (the
 * shim patches node:fs process-wide, so installing it inside the test runner
 * would sandbox vitest itself). Regression for the on-device boot death where
 * an alias-spelled ELIZA_STATE_DIR was rejected against a canonical root and
 * the agent died at startEliza before it could even write diagnostics.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { androidAliasSibling } from "./fs-shim.ts";

const SHIM_PATH = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "fs-shim.ts",
);

describe("androidAliasSibling", () => {
  it("maps /data/data/<pkg> to /data/user/0/<pkg> and back", () => {
    expect(androidAliasSibling("/data/data/ai.elizaos.app")).toBe(
      "/data/user/0/ai.elizaos.app",
    );
    expect(androidAliasSibling("/data/user/0/ai.elizaos.app")).toBe(
      "/data/data/ai.elizaos.app",
    );
  });

  it("preserves the path suffix under the package dir", () => {
    expect(
      androidAliasSibling("/data/data/ai.elizaos.app/files/eliza/eliza.json"),
    ).toBe("/data/user/0/ai.elizaos.app/files/eliza/eliza.json");
    expect(androidAliasSibling("/data/user/0/pkg.x/files")).toBe(
      "/data/data/pkg.x/files",
    );
  });

  it("returns null for non-aliased paths", () => {
    // Secondary Android users are NOT the /data/data alias — only user 0.
    expect(androidAliasSibling("/data/user/10/ai.elizaos.app")).toBeNull();
    expect(androidAliasSibling("/data/local/tmp/.eliza")).toBeNull();
    expect(androidAliasSibling("/var/mobile/Containers/x")).toBeNull();
    expect(androidAliasSibling("/data/data")).toBeNull();
  });

  it("does not treat sibling-prefixed package names as aliases of each other", () => {
    expect(androidAliasSibling("/data/data/pkg")).toBe("/data/user/0/pkg");
    // A path like /data/data/pkg-evil must map only to its own name.
    expect(androidAliasSibling("/data/data/pkg-evil/x")).toBe(
      "/data/user/0/pkg-evil/x",
    );
  });
});

describe("installMobileFsShim alias acceptance (real shim, Bun subprocess)", () => {
  it("accepts the alias spelling of the workspace root and still blocks escapes", () => {
    const script = [
      `const { installMobileFsShim, sandboxedPath } = await import(${JSON.stringify(SHIM_PATH)});`,
      `installMobileFsShim("/data/user/0/test.alias.pkg/files");`,
      `const out = { aliasAccepted: false, canonicalAccepted: false, escapeBlocked: false, otherPkgBlocked: false };`,
      `try { sandboxedPath("/data/data/test.alias.pkg/files/eliza/eliza.json"); out.aliasAccepted = true; } catch {}`,
      `try { sandboxedPath("/data/user/0/test.alias.pkg/files/agent/agent-bundle.js"); out.canonicalAccepted = true; } catch {}`,
      `try { sandboxedPath("/data/user/0/test.alias.pkg/files-escape/x"); } catch { out.escapeBlocked = true; }`,
      `try { sandboxedPath("/data/data/other.pkg/files/x"); } catch { out.otherPkgBlocked = true; }`,
      `console.log(JSON.stringify(out));`,
    ].join("\n");
    const stdout = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const lastLine = stdout.trim().split("\n").at(-1) ?? "";
    const result = JSON.parse(lastLine) as Record<string, boolean>;
    expect(result).toEqual({
      aliasAccepted: true,
      canonicalAccepted: true,
      escapeBlocked: true,
      otherPkgBlocked: true,
    });
  });

  it("accepts an explicit packaged read-only root without allowing writes", () => {
    const fixtureRoot = mkdtempSync(nodePath.join(tmpdir(), "eliza-fs-shim-"));
    const workspaceRoot = nodePath.join(fixtureRoot, "workspace");
    const publicRoot = nodePath.join(fixtureRoot, "App.app", "public");
    const registryPath = nodePath.join(publicRoot, "generated-registry.json");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(publicRoot, { recursive: true });
    const expectedRegistry = '{"registry":{"fixture":{"version":"1.2.3"}}}\n';
    writeFileSync(registryPath, expectedRegistry);

    try {
      const script = [
        `(async () => {`,
        `const { installMobileFsShim } = await import(${JSON.stringify(SHIM_PATH)});`,
        `installMobileFsShim(${JSON.stringify(workspaceRoot)}, { readOnlyRoots: [${JSON.stringify(publicRoot)}] });`,
        `const fs = require("node:fs");`,
        `const out = { before: fs.readFileSync(${JSON.stringify(registryPath)}, "utf8"), writeBlocked: false, after: "" };`,
        `try { fs.writeFileSync(${JSON.stringify(registryPath)}, "changed"); } catch (error) { out.writeBlocked = error?.code === "EACCES"; }`,
        `out.after = fs.readFileSync(${JSON.stringify(registryPath)}, "utf8");`,
        `console.log(JSON.stringify(out));`,
        `})().catch((error) => { console.error(error); process.exitCode = 1; });`,
      ].join("\n");
      const stdout = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        timeout: 30_000,
      });
      const lastLine = stdout.trim().split("\n").at(-1) ?? "";
      expect(JSON.parse(lastLine)).toEqual({
        before: expectedRegistry,
        writeBlocked: true,
        after: expectedRegistry,
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts the real spelling of roots that were passed through a symlink", () => {
    // iOS: the Swift host passes appSupport.resolvingSymlinksInPath(), which
    // strips /private (/var/mobile/...), while realpath(3) returns
    // /private/var/mobile/... . saveElizaConfig (packages/agent) realpaths an
    // existing eliza.json and writes through that spelling.
    const fixtureRoot = mkdtempSync(nodePath.join(tmpdir(), "eliza-fs-shim-"));
    const realVar = nodePath.join(fixtureRoot, "private", "var");
    const realWorkspace = nodePath.join(realVar, "app-support");
    const realPublic = nodePath.join(realVar, "App.app", "public");
    mkdirSync(realWorkspace, { recursive: true });
    mkdirSync(realPublic, { recursive: true });
    mkdirSync(nodePath.join(realVar, "app-support-escape"));
    // fixtureRoot/var -> fixtureRoot/private/var, like iOS /var -> /private/var.
    symlinkSync(realVar, nodePath.join(fixtureRoot, "var"));
    const workspaceRoot = nodePath.join(fixtureRoot, "var", "app-support");
    const publicRoot = nodePath.join(fixtureRoot, "var", "App.app", "public");
    const configPath = nodePath.join(workspaceRoot, "eliza.json");
    const registryPath = nodePath.join(publicRoot, "generated-registry.json");
    writeFileSync(configPath, '{"saved":1}\n');
    writeFileSync(registryPath, '{"registry":{}}\n');
    const realConfigPath = realpathSync(configPath);
    const realRegistryPath = realpathSync(registryPath);
    const realVarReal = realpathSync(realVar);

    try {
      const script = [
        `(async () => {`,
        `const { installMobileFsShim } = await import(${JSON.stringify(SHIM_PATH)});`,
        `installMobileFsShim(${JSON.stringify(workspaceRoot)}, { readOnlyRoots: [${JSON.stringify(publicRoot)}] });`,
        `const fs = require("node:fs");`,
        `const path = require("node:path");`,
        `const attempt = (fn) => { try { fn(); return "ok"; } catch (error) { return String(error?.code); } };`,
        `const out = {};`,
        `const realConfigPath = fs.realpathSync(${JSON.stringify(configPath)});`,
        `out.realConfigPath = realConfigPath;`,
        `out.save = attempt(() => { fs.writeFileSync(realConfigPath + ".tmp", '{"saved":2}\\n'); fs.renameSync(realConfigPath + ".tmp", realConfigPath); });`,
        `out.config = fs.readFileSync(${JSON.stringify(configPath)}, "utf8");`,
        `out.mkdirReal = attempt(() => fs.mkdirSync(path.join(path.dirname(realConfigPath), "auth"), { recursive: true }));`,
        `out.readPublicReal = attempt(() => fs.readFileSync(${JSON.stringify(realRegistryPath)}, "utf8"));`,
        `out.writePublicReal = attempt(() => fs.writeFileSync(${JSON.stringify(realRegistryPath)}, "changed"));`,
        `out.writeOutside = attempt(() => fs.writeFileSync(${JSON.stringify(nodePath.join(realVarReal, "outside.txt"))}, "x"));`,
        `out.writeSibling = attempt(() => fs.writeFileSync(${JSON.stringify(nodePath.join(realVarReal, "app-support-escape", "x.txt"))}, "x"));`,
        `console.log(JSON.stringify(out));`,
        `})().catch((error) => { console.error(error); process.exitCode = 1; });`,
      ].join("\n");
      const stdout = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        timeout: 30_000,
      });
      const lastLine = stdout.trim().split("\n").at(-1) ?? "";
      expect(JSON.parse(lastLine)).toEqual({
        realConfigPath,
        save: "ok",
        config: '{"saved":2}\n',
        mkdirReal: "ok",
        readPublicReal: "ok",
        writePublicReal: "EACCES",
        writeOutside: "EACCES",
        writeSibling: "EACCES",
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
