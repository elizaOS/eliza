/**
 * Tests the per-deploy service-worker versioning plugin
 * (CONVERSATIONS-500-2026-07-22 fix #1): it must stamp a byte-unique build rev
 * into the emitted `dist/sw.js` so a normal deploy produces a byte-CHANGED sw.js
 * (the browser's SW byte-diff then detects a new worker and auto-updates).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSwBuildRev,
  swBuildRevPlugin,
} from "../vite/sw-build-rev-plugin";

const TOKEN = "__SW_BUILD_REV__";

function runCloseBundle(
  plugin: ReturnType<typeof swBuildRevPlugin>,
  outDir: string,
) {
  // Drive the plugin the way Vite does: configResolved then closeBundle.
  const info: string[] = [];
  const warn: string[] = [];
  const ctx = {
    info: (m: string) => info.push(m),
    warn: (m: string) => warn.push(m),
  };
  (plugin.configResolved as (c: { build: { outDir: string } }) => void).call(
    ctx,
    { build: { outDir } },
  );
  (plugin.closeBundle as () => void).call(ctx);
  return { info, warn };
}

describe("swBuildRevPlugin", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sw-build-rev-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.GIT_COMMIT;
    delete process.env.GIT_SHA;
  });

  it("replaces the __SW_BUILD_REV__ sentinel in dist/sw.js with the env sha", () => {
    process.env.GIT_COMMIT = "abcdef0123456789";
    writeFileSync(
      path.join(dir, "sw.js"),
      `const BUILD_REV = "${TOKEN}";\n// cache: elizaos-shell-v6-${TOKEN}\n`,
    );

    runCloseBundle(swBuildRevPlugin(), dir);

    const out = readFileSync(path.join(dir, "sw.js"), "utf8");
    expect(out).not.toContain(TOKEN);
    // env sha is truncated to 12 chars.
    expect(out).toContain("abcdef012345");
    // ALL occurrences replaced (the const AND the cache-name usage).
    expect(out.match(/abcdef012345/g)?.length).toBe(2);
  });

  it("makes two builds at different revs produce BYTE-DIFFERENT sw.js (the whole point)", () => {
    const template = `const BUILD_REV = "${TOKEN}";\n`;

    process.env.GIT_COMMIT = "1111111111111111";
    writeFileSync(path.join(dir, "sw.js"), template);
    runCloseBundle(swBuildRevPlugin(), dir);
    const first = readFileSync(path.join(dir, "sw.js"), "utf8");

    process.env.GIT_COMMIT = "2222222222222222";
    writeFileSync(path.join(dir, "sw.js"), template);
    runCloseBundle(swBuildRevPlugin(), dir);
    const second = readFileSync(path.join(dir, "sw.js"), "utf8");

    expect(first).not.toBe(second);
  });

  it("is a no-op when dist/sw.js is absent (secondary single-file build)", () => {
    // No sw.js written — closeBundle must not throw.
    expect(() => runCloseBundle(swBuildRevPlugin(), dir)).not.toThrow();
  });

  it("is idempotent / safe when sw.js has no sentinel (already stamped)", () => {
    const already = `const BUILD_REV = "deadbeefcafe";\n`;
    writeFileSync(path.join(dir, "sw.js"), already);
    runCloseBundle(swBuildRevPlugin(), dir);
    expect(readFileSync(path.join(dir, "sw.js"), "utf8")).toBe(already);
  });

  it("resolveSwBuildRev prefers env sha (12 chars) and always returns a non-empty rev", () => {
    process.env.GIT_COMMIT = "0123456789abcdef";
    expect(resolveSwBuildRev()).toBe("0123456789ab");
    delete process.env.GIT_COMMIT;
    // No env → git or timestamp fallback, but never empty.
    expect(resolveSwBuildRev().length).toBeGreaterThan(0);
  });
});
