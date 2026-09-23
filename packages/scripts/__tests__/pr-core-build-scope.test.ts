/** Exercises PR bootstrap selection against real committed Git histories, including deleted ownership and fail-closed CLI output. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planPrCoreBuild } from "../pr-core-build-scope.mjs";

const roots: string[] = [];
const cli = fileURLToPath(
  new URL("../pr-core-build-scope.mjs", import.meta.url),
);
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pr-core-scope-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  write(
    "package.json",
    JSON.stringify({
      private: true,
      workspaces: ["packages/*", "packages/*/nested/*"],
    }),
  );
  write(
    "packages/leaf/package.json",
    JSON.stringify({ name: "leaf", scripts: { build: "node build.mjs" } }),
  );
  write("packages/leaf/src.ts", "export const value = 1;\n");
  write("scripts/shared.mjs", "export const shared = true;\n");
  write(".github/workflows/codeql.yml", "name: CodeQL\n");
  const base = commit();
  return {
    root,
    git,
    write,
    commit,
    base,
    plan: () => planPrCoreBuild({ repoRoot: root, base }),
  };
}

test("CodeQL-only commit emits an exact-head skip receipt through the real CLI", () => {
  const f = fixture();
  f.write(".github/workflows/codeql.yml", "name: Scoped CodeQL\n");
  const head = f.commit();
  const output = join(f.root, "output");
  const result = spawnSync(process.execPath, [cli, f.base, output], {
    cwd: f.root,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(readFileSync(output, "utf8")).toBe("core_bootstrap_required=false\n");
  expect(JSON.parse(result.stdout)).toMatchObject({
    head,
    base: f.base,
    required: false,
  });
});

test("owned leaf changes use affected builds, while mixed shared inputs retain bootstrap", () => {
  const f = fixture();
  f.write("packages/leaf/src.ts", "export const value = 2;\n");
  f.commit();
  expect(f.plan().required).toBe(false);
  f.write("scripts/shared.mjs", "export const shared = false;\n");
  f.commit();
  expect(f.plan().broadInputs).toEqual(["scripts/shared.mjs"]);
});

test("moving a shared input into a workspace preserves the old shared boundary", () => {
  const f = fixture();
  f.git("mv", "scripts/shared.mjs", "packages/leaf/shared.mjs");
  f.commit();
  expect(f.plan().broadInputs).toEqual(["scripts/shared.mjs"]);
});

test("deleted manifests cannot be replaced with an untracked owner", () => {
  const f = fixture();
  f.git("rm", "packages/leaf/package.json");
  f.commit();
  f.write(
    "packages/leaf/package.json",
    JSON.stringify({ name: "leaf", scripts: { build: "true" } }),
  );
  expect(f.plan().required).toBe(true);
});

test("a nested workspace without a build cannot inherit its parent's build ownership", () => {
  const f = fixture();
  f.write(
    "packages/leaf/nested/child/package.json",
    JSON.stringify({ name: "child" }),
  );
  f.commit();
  expect(f.plan().required).toBe(true);
});

test("a malformed committed manifest aborts selection", () => {
  const f = fixture();
  f.write("packages/leaf/package.json", "invalid JSON");
  f.commit();
  expect(() => f.plan()).toThrow("Invalid JSON");
});

test("invalid Git bases and dirty tracked source never publish a skip output", () => {
  const f = fixture();
  for (const base of ["HEAD~1", "0".repeat(40)]) {
    const output = join(f.root, `output-${base}`);
    const result = spawnSync(process.execPath, [cli, base, output], {
      cwd: f.root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  }
  f.write("packages/leaf/src.ts", "dirty\n");
  const output = join(f.root, "dirty-output");
  const result = spawnSync(process.execPath, [cli, f.base, output], {
    cwd: f.root,
    encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(existsSync(output)).toBe(false);
});

test("a valid commit outside HEAD ancestry is rejected", () => {
  const f = fixture();
  f.git("checkout", "-qb", "side");
  f.write("side.txt", "side");
  const side = f.commit();
  f.git("checkout", "--detach", f.base);
  expect(() => planPrCoreBuild({ repoRoot: f.root, base: side })).toThrow();
});

test("deleting a nested owner does not attribute its deletion to the parent", () => {
  const f = fixture();
  f.write(
    "packages/leaf/nested/child/package.json",
    JSON.stringify({ name: "child", scripts: { build: "true" } }),
  );
  const base = f.commit();
  f.git("rm", "packages/leaf/nested/child/package.json");
  f.commit();
  expect(planPrCoreBuild({ repoRoot: f.root, base }).required).toBe(true);
});

test("unnamed workspaces cannot claim an executable Turbo build", () => {
  const f = fixture();
  f.write(
    "packages/leaf/package.json",
    JSON.stringify({ scripts: { build: "true" } }),
  );
  f.commit();
  expect(f.plan().required).toBe(true);
});
