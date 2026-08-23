/**
 * Colocated coverage for app-core server startup helpers. Drives the real
 * `isSafeResetStateDir`, `findOwnPackageRoot`, and re-exported
 * `resolveCorsOrigin` — no mocks of the module under test. Pins the
 * under-home + allowed-segment reset guard (including app-core's extra
 * `elizaai` / `elizaos` / dotted-name path), the 10-level package-root walk
 * with malformed-metadata skip, and CORS origin allow/deny branches.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findOwnPackageRoot,
  isSafeResetStateDir,
  resolveCorsOrigin,
} from "./server-startup";

const HOME = "/home/user";

describe("isSafeResetStateDir", () => {
  it("allows an under-home path that already carries an 'eliza' segment", () => {
    expect(isSafeResetStateDir("/home/user/.local/state/eliza", HOME)).toBe(
      true,
    );
    expect(isSafeResetStateDir("/home/user/eliza", HOME)).toBe(true);
  });

  it("allows a single-element under-home 'eliza' directory", () => {
    expect(isSafeResetStateDir(path.join(HOME, "eliza"), HOME)).toBe(true);
  });

  it("refuses the filesystem root even when the other argument is home", () => {
    expect(isSafeResetStateDir("/", HOME)).toBe(false);
  });

  it("refuses the home directory itself", () => {
    expect(isSafeResetStateDir(HOME, HOME)).toBe(false);
    expect(isSafeResetStateDir(`${HOME}/`, HOME)).toBe(false);
  });

  it("refuses a directory outside home even when it has an eliza segment", () => {
    expect(isSafeResetStateDir("/tmp/eliza", HOME)).toBe(false);
    expect(isSafeResetStateDir("/var/lib/eliza", HOME)).toBe(false);
    expect(isSafeResetStateDir("/eliza", HOME)).toBe(false);
  });

  it("refuses a traversal that escapes home", () => {
    expect(isSafeResetStateDir("/home/user/../etc/eliza", HOME)).toBe(false);
  });

  it("refuses an under-home path that lacks any allowed package-root segment", () => {
    expect(isSafeResetStateDir("/home/user/Documents", HOME)).toBe(false);
    expect(
      isSafeResetStateDir("/home/user/.local/state/custom-app", HOME),
    ).toBe(false);
  });

  it("does not treat a longer segment that merely contains 'eliza' as allowed", () => {
    expect(isSafeResetStateDir("/home/user/eliza-data", HOME)).toBe(false);
    expect(isSafeResetStateDir("/home/user/myeliza", HOME)).toBe(false);
    expect(isSafeResetStateDir("/home/user/.eliza-backup", HOME)).toBe(false);
  });

  it("allows under-home 'elizaos' and 'elizaai' segments that upstream 'eliza'-only matching rejects", () => {
    expect(isSafeResetStateDir("/home/user/.local/state/elizaos", HOME)).toBe(
      true,
    );
    expect(isSafeResetStateDir("/home/user/elizaai", HOME)).toBe(true);
  });

  it("allows under-home dotted package-root segments (.eliza, .elizaos, .elizaai)", () => {
    expect(isSafeResetStateDir("/home/user/.eliza", HOME)).toBe(true);
    expect(isSafeResetStateDir("/home/user/.elizaos", HOME)).toBe(true);
    expect(isSafeResetStateDir("/home/user/.elizaai", HOME)).toBe(true);
  });

  it("matches allowed segments case-insensitively and after trim", () => {
    expect(isSafeResetStateDir("/home/user/Eliza", HOME)).toBe(true);
    expect(isSafeResetStateDir("/home/user/ELIZAOS", HOME)).toBe(true);
    expect(isSafeResetStateDir("/home/user/.ElizaAI", HOME)).toBe(true);
    expect(isSafeResetStateDir("/home/user/ Eliza ", HOME)).toBe(true);
  });
});

describe("findOwnPackageRoot", () => {
  const trees: string[] = [];

  afterEach(() => {
    for (const dir of trees.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTree(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-core-pkg-root-"));
    trees.push(dir);
    return dir;
  }

  function writePackageJson(dir: string, body: unknown): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      typeof body === "string" ? body : `${JSON.stringify(body)}\n`,
      "utf8",
    );
  }

  it("returns startDir when it is already a matching package root (single element)", () => {
    const root = makeTree();
    writePackageJson(root, { name: "eliza" });
    expect(findOwnPackageRoot(root)).toBe(root);
  });

  it("matches package names elizaai and elizaos, including mixed case", () => {
    const elizaai = makeTree();
    writePackageJson(elizaai, { name: "ElizaAI" });
    expect(findOwnPackageRoot(elizaai)).toBe(elizaai);

    const elizaos = makeTree();
    writePackageJson(elizaos, { name: "ElizaOS" });
    expect(findOwnPackageRoot(elizaos)).toBe(elizaos);
  });

  it("does not treat a scoped or prefixed name as a package-root match", () => {
    const root = makeTree();
    writePackageJson(root, { name: "@elizaos/core" });
    const start = path.join(root, "leaf");
    fs.mkdirSync(start, { recursive: true });
    expect(findOwnPackageRoot(start)).toBe(start);
  });

  it("does not trim package names before matching, so a padded ' eliza' is not a hit", () => {
    const root = makeTree();
    writePackageJson(root, { name: " eliza" });
    const start = path.join(root, "leaf");
    fs.mkdirSync(start, { recursive: true });
    expect(findOwnPackageRoot(start)).toBe(start);
  });

  it("returns a directory that has plugins.json even when package.json name does not match", () => {
    const root = makeTree();
    writePackageJson(root, { name: "something-else" });
    fs.writeFileSync(path.join(root, "plugins.json"), "{}\n", "utf8");
    const nested = path.join(root, "src", "api");
    fs.mkdirSync(nested, { recursive: true });
    expect(findOwnPackageRoot(nested)).toBe(root);
  });

  it("walks upward and returns the nearest matching ancestor", () => {
    const root = makeTree();
    writePackageJson(root, { name: "elizaos" });
    const nested = path.join(root, "packages", "app-core", "src", "api");
    fs.mkdirSync(nested, { recursive: true });
    writePackageJson(path.join(root, "packages", "app-core"), {
      name: "@elizaos/app-core",
    });
    expect(findOwnPackageRoot(nested)).toBe(root);
  });

  it("skips malformed package.json and keeps walking to a readable ancestor", () => {
    const root = makeTree();
    writePackageJson(root, { name: "eliza" });
    const broken = path.join(root, "broken");
    writePackageJson(broken, "{");
    const start = path.join(broken, "child");
    fs.mkdirSync(start, { recursive: true });
    expect(findOwnPackageRoot(start)).toBe(root);
  });

  it("skips a non-string package name and a missing name, then finds plugins.json above", () => {
    const root = makeTree();
    writePackageJson(root, { name: "unrelated" });
    fs.writeFileSync(path.join(root, "plugins.json"), "{}\n", "utf8");
    const numbered = path.join(root, "numbered");
    writePackageJson(numbered, { name: 42 });
    const unnamed = path.join(numbered, "unnamed");
    writePackageJson(unnamed, {});
    const start = path.join(unnamed, "leaf");
    fs.mkdirSync(start, { recursive: true });
    expect(findOwnPackageRoot(start)).toBe(root);
  });

  it("returns startDir when no ancestor within the walk is a package root (empty / missing)", () => {
    const root = makeTree();
    const start = path.join(root, "orphan", "leaf");
    fs.mkdirSync(start, { recursive: true });
    expect(findOwnPackageRoot(start)).toBe(start);
  });

  it("finds a match at the 10th directory checked (startDir plus nine ancestors)", () => {
    const match = makeTree();
    writePackageJson(match, { name: "eliza" });
    let dir = match;
    for (let i = 0; i < 9; i += 1) {
      dir = path.join(dir, `d${i}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    expect(findOwnPackageRoot(dir)).toBe(match);
  });

  it("returns startDir when the matching root is past the 10-level walk capacity", () => {
    const match = makeTree();
    writePackageJson(match, { name: "eliza" });
    let dir = match;
    for (let i = 0; i < 10; i += 1) {
      dir = path.join(dir, `d${i}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    expect(findOwnPackageRoot(dir)).toBe(dir);
  });

  it("still walks ancestors even when ELIZA_MOBILE_PLATFORM is set (app-core does not short-circuit)", () => {
    const root = makeTree();
    writePackageJson(root, { name: "eliza" });
    const nested = path.join(root, "mobile", "bundle");
    fs.mkdirSync(nested, { recursive: true });
    const previous = process.env.ELIZA_MOBILE_PLATFORM;
    process.env.ELIZA_MOBILE_PLATFORM = "ios";
    try {
      expect(findOwnPackageRoot(nested)).toBe(root);
    } finally {
      if (previous === undefined) delete process.env.ELIZA_MOBILE_PLATFORM;
      else process.env.ELIZA_MOBILE_PLATFORM = previous;
    }
  });
});

describe("resolveCorsOrigin", () => {
  const TOUCHED_ENV_KEYS = [
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_API_BIND",
    "ELIZA_ALLOWED_ORIGINS",
    "CORS_ORIGINS",
    "ELIZA_ALLOW_NULL_ORIGIN",
    "WAIFU_CHAT_ACCESS_JWT_SECRET",
    "WAIFU_CHAT_FRAME_ANCESTORS",
  ] as const;

  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    saved.clear();
    for (const key of TOUCHED_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.ELIZA_API_BIND = "127.0.0.1";
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("returns null for a missing, empty, or whitespace-only origin", () => {
    expect(resolveCorsOrigin()).toBeNull();
    expect(resolveCorsOrigin(undefined)).toBeNull();
    expect(resolveCorsOrigin("")).toBeNull();
    expect(resolveCorsOrigin("   ")).toBeNull();
    expect(resolveCorsOrigin("\t\n")).toBeNull();
  });

  it("reflects any trimmed origin when ELIZA_CLOUD_PROVISIONED is 1", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(resolveCorsOrigin("https://dashboard.example")).toBe(
      "https://dashboard.example",
    );
    expect(resolveCorsOrigin("  https://other.example  ")).toBe(
      "https://other.example",
    );
  });

  it("reflects any trimmed origin when the API bind host is a wildcard", () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    expect(resolveCorsOrigin("https://remote.example")).toBe(
      "https://remote.example",
    );
    process.env.ELIZA_API_BIND = "::";
    expect(resolveCorsOrigin("https://remote.example")).toBe(
      "https://remote.example",
    );
  });

  it("allows an origin that is on the explicit ELIZA_ALLOWED_ORIGINS list", () => {
    process.env.ELIZA_ALLOWED_ORIGINS =
      "https://app.example, https://other.example";
    expect(resolveCorsOrigin("https://app.example")).toBe(
      "https://app.example",
    );
    expect(resolveCorsOrigin("https://other.example")).toBe(
      "https://other.example",
    );
    expect(resolveCorsOrigin("https://not-listed.example")).toBeNull();
  });

  it("allows loopback http(s) origins and rejects a non-local http origin", () => {
    expect(resolveCorsOrigin("http://localhost")).toBe("http://localhost");
    expect(resolveCorsOrigin("http://localhost:31337")).toBe(
      "http://localhost:31337",
    );
    expect(resolveCorsOrigin("https://127.0.0.1")).toBe("https://127.0.0.1");
    expect(resolveCorsOrigin("http://[::1]:8080")).toBe("http://[::1]:8080");
    expect(resolveCorsOrigin("HTTP://LOCALHOST")).toBe("HTTP://LOCALHOST");
    expect(resolveCorsOrigin("https://evil.example")).toBeNull();
    expect(resolveCorsOrigin("ftp://localhost")).toBeNull();
  });

  it("allows packaged app-scheme origins including exact file://", () => {
    expect(resolveCorsOrigin("capacitor://localhost")).toBe(
      "capacitor://localhost",
    );
    expect(resolveCorsOrigin("tauri://localhost")).toBe("tauri://localhost");
    expect(resolveCorsOrigin("electrobun://app")).toBe("electrobun://app");
    expect(resolveCorsOrigin("app://.")).toBe("app://.");
    expect(resolveCorsOrigin("file://")).toBe("file://");
    expect(resolveCorsOrigin("file:///Users/me/index.html")).toBe(
      "file:///Users/me/index.html",
    );
  });

  it("returns the literal 'null' origin only when ELIZA_ALLOW_NULL_ORIGIN is enabled", () => {
    expect(resolveCorsOrigin("null")).toBeNull();
    process.env.ELIZA_ALLOW_NULL_ORIGIN = "1";
    expect(resolveCorsOrigin("null")).toBe("null");
  });

  it("allows https://waifu.fun and subdomains only when the waifu JWT secret is set", () => {
    expect(resolveCorsOrigin("https://waifu.fun")).toBeNull();
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "secret";
    expect(resolveCorsOrigin("https://waifu.fun")).toBe("https://waifu.fun");
    expect(resolveCorsOrigin("https://chat.waifu.fun")).toBe(
      "https://chat.waifu.fun",
    );
    expect(resolveCorsOrigin("http://waifu.fun")).toBeNull();
    expect(resolveCorsOrigin("https://notwaifu.fun")).toBeNull();
    expect(resolveCorsOrigin("https://waifu.fun.evil.example")).toBeNull();
  });
});
