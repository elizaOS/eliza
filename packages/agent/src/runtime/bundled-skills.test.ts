/**
 * Exercises host bundle selection using real temporary packages and subprocess
 * imports, including deployments without skills and installed-but-broken bundles.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(source?: string, entry = "./index.js"): string {
  const root = mkdtempSync(join(tmpdir(), "host-bundled-skills-"));
  roots.push(root);
  copyFileSync(
    fileURLToPath(new URL("./bundled-skills.ts", import.meta.url)),
    join(root, "bundled-skills.ts"),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  if (source !== undefined) {
    const pkg = join(root, "node_modules", "@elizaos", "skills");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@elizaos/skills",
        type: "module",
        exports: { ".": entry, "./package.json": "./package.json" },
      }),
    );
    writeFileSync(join(pkg, "index.js"), source);
  }
  writeFileSync(
    join(root, "run.ts"),
    [
      'import { resolveBundledSkillsDir } from "./bundled-skills.ts";',
      "try { console.log(JSON.stringify({ directory: await resolveBundledSkillsDir() })); }",
      "catch (error) { console.log(JSON.stringify({ message: error.message, code: error.code })); }",
    ].join("\n"),
  );
  return root;
}

function runFixture(root: string, executable = process.execPath) {
  return JSON.parse(
    execFileSync(
      executable,
      [...(executable === "bun" ? ["--no-install"] : []), join(root, "run.ts")],
      {
        encoding: "utf8",
      },
    ).trim(),
  );
}

test.each([process.execPath, "bun"])(
  "%s supports a deployment without the optional package",
  (executable) => {
    expect(runFixture(fixture(), executable)).toEqual({ directory: null });
  },
);

test("an installed bundle returns its configured directory", () => {
  expect(
    runFixture(
      fixture('export const getSkillsDir = () => "/selected/bundle";'),
    ),
  ).toEqual({ directory: "/selected/bundle" });
});

test.each([
  [
    "evaluation",
    'throw new Error("bundle evaluation failed");',
    "bundle evaluation failed",
  ],
  [
    "transitive dependency",
    'import "./missing-dependency.js";',
    "missing-dependency.js",
  ],
  [
    "resolver",
    'export function getSkillsDir() { throw Object.assign(new Error("invalid configured directory"), { code: "BUNDLED_SKILLS_OVERRIDE_INVALID" }); }',
    "invalid configured directory",
  ],
])(
  "an installed bundle's %s failure is not optional absence",
  (_kind, source, message) => {
    const result = runFixture(fixture(source));
    expect(result.message).toContain(message);
    expect(result).not.toHaveProperty("directory");
  },
);

test.each([process.execPath, "bun"])(
  "%s rejects a declared missing entry point",
  (executable) => {
    const result = runFixture(
      fixture(
        "export const getSkillsDir = () => '/unused';",
        "./missing-entry.js",
      ),
      executable,
    );
    expect(result.code).toMatch(/^(?:ERR_)?MODULE_NOT_FOUND$/);
    expect(result).not.toHaveProperty("directory");
  },
);

test("host startup rejects an invalid override through the real skills resolver", () => {
  const root = fixture();
  const runner = join(root, "real-resolver.ts");
  writeFileSync(
    runner,
    [
      `import { resolveBundledSkillsDir } from ${JSON.stringify(new URL("./bundled-skills.ts", import.meta.url).href)};`,
      "try { console.log(JSON.stringify({ directory: await resolveBundledSkillsDir() })); }",
      "catch (error) { console.log(JSON.stringify({ code: error.code, context: error.context, cause: error.cause?.code })); }",
    ].join("\n"),
  );
  const directory = join(root, "missing-selected-bundle");
  const result = JSON.parse(
    execFileSync("bun", ["--no-install", runner], {
      env: { ...process.env, ELIZAOS_BUNDLED_SKILLS_DIR: directory },
      encoding: "utf8",
    }).trim(),
  );
  expect(result).toEqual({
    code: "BUNDLED_SKILLS_OVERRIDE_INVALID",
    context: { setting: "ELIZAOS_BUNDLED_SKILLS_DIR", directory },
    cause: "ENOENT",
  });
});
