#!/usr/bin/env node
/**
 * Publish Clawd-related packages to npm from isolated temp copies
 * (avoids monorepo workspace npm conflicts).
 *
 * Default: dry-run. Use --apply for real publish.
 * Scope rewrite: --npm-scope=x402solana maps package names into that scope
 * (required when the logged-in user cannot publish @solana-clawd / @elizaos).
 *
 * Examples:
 *   node scripts/publish-clawd-packages.mjs
 *   node scripts/publish-clawd-packages.mjs --apply --npm-scope=x402solana
 *   node scripts/publish-clawd-packages.mjs --apply --only=clawd-code --npm-scope=x402solana
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : null;
const scopeArg = process.argv.find((a) => a.startsWith("--npm-scope="));
const npmScope = scopeArg ? scopeArg.slice("--npm-scope=".length).replace(/^@/, "") : null;

const PACKAGES = [
  {
    id: "clawd-code",
    dir: "plugins/clawd-code",
    name: "@solana-clawd/clawd-code",
    copyExtra: ["dist", "src", "install.sh", "README.md", "LICENSE", ".env.example", "clawd.json", "tsconfig.json", "package-lock.json", "clawd-plugin", "docs", "spinners"],
  },
  {
    id: "clawd-plugin",
    dir: "plugins/clawd-plugin",
    name: "@solana-clawd/clawd-plugin",
    copyExtra: [".clawd-plugin", ".mcp.json", "scripts", "skills", "README.md", "LICENSE"],
  },
  {
    id: "cheshire-eliza",
    dir: "packages/cheshire-eliza",
    name: "@elizaos/cheshire-eliza",
    copyExtra: ["src", "docs", "README.md"],
  },
  {
    id: "plugin-cheshire-memory",
    dir: "plugins/plugin-cheshire-memory",
    name: "@elizaos/plugin-cheshire-memory",
    build: ["bun", "run", "build.ts"],
    copyExtra: ["dist", "src", "README.md", "build.ts", "tsconfig.json"],
  },
  {
    id: "plugin-clawdbrowser",
    dir: "plugins/plugin-clawdbrowser",
    name: "@elizaos/plugin-clawdbrowser",
    build: ["bun", "run", "build.ts"],
    copyExtra: ["dist", "src", "README.md", "build.ts", "tsconfig.json", "registry-entry.json"],
  },
];

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(" ")}  (cwd=${cwd})`);
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with code ${res.status}`);
  }
}

function whoami() {
  const res = spawnSync("npm", ["whoami"], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error("Not logged in to npm. Run: npm login");
  }
  return res.stdout.trim();
}

function mapName(name) {
  if (!npmScope) return name;
  const bare = name.includes("/") ? name.split("/")[1] : name;
  return `@${npmScope}/${bare}`;
}

function rewriteWorkspaceDeps(pkg) {
  const next = { ...pkg, publishConfig: { access: "public", ...(pkg.publishConfig || {}) } };
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (!next[field]) continue;
    const deps = { ...next[field] };
    for (const [k, v] of Object.entries(deps)) {
      if (typeof v === "string" && v.startsWith("workspace:")) {
        deps[k] = v.replace(/^workspace:/, "").replace(/^\*/, ">=0.0.0") || ">=0.0.0";
        if (deps[k] === "*") deps[k] = ">=0.0.0";
        // workspace:* → open range
        if (v === "workspace:*") deps[k] = ">=0.0.0";
      }
      // map sibling clawd deps into chosen scope when rewriting
      if (npmScope && k.startsWith("@solana-clawd/")) {
        const bare = k.split("/")[1];
        delete deps[k];
        deps[`@${npmScope}/${bare}`] = deps[`@${npmScope}/${bare}`] || "^1.0.0";
      }
    }
    next[field] = deps;
  }
  next.name = mapName(pkg.name);
  return next;
}

function stagePackage(target) {
  const srcRoot = join(root, target.dir);
  const stage = mkdtempSync(join(tmpdir(), `clawd-pub-${target.id}-`));
  const pkgSrc = join(srcRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgSrc, "utf8"));
  if (pkg.private === true) throw new Error(`${pkg.name} is private`);

  // Always copy package.json (rewritten)
  const rewritten = rewriteWorkspaceDeps(pkg);
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(rewritten, null, 2)}\n`);

  for (const rel of target.copyExtra || []) {
    const from = join(srcRoot, rel);
    if (!existsSync(from)) {
      console.warn(`  missing optional path: ${rel}`);
      continue;
    }
    cpSync(from, join(stage, rel), { recursive: true });
  }

  // Prefer a README; fall back to monorepo clawd.md snippet name
  if (!existsSync(join(stage, "README.md")) && existsSync(join(root, "clawd.md"))) {
    cpSync(join(root, "clawd.md"), join(stage, "README.md"));
  }

  return { stage, pkg: rewritten };
}

function buildInPlace(target) {
  if (!target.build) return;
  const abs = join(root, target.dir);
  try {
    run(target.build[0], target.build.slice(1), abs);
  } catch (err) {
    if (existsSync(join(abs, "dist"))) {
      console.warn(`build warning (using existing dist): ${err.message}`);
      return;
    }
    throw err;
  }
}

function main() {
  console.log(apply ? "MODE: APPLY (real publish)" : "MODE: dry-run");
  if (npmScope) console.log(`npm scope rewrite: @${npmScope}/*`);
  const user = whoami();
  console.log(`npm user: ${user}`);

  const targets = PACKAGES.filter(
    (p) => !only || p.id === only || p.name === only || p.dir === only,
  );
  if (!targets.length) throw new Error(`No packages matched --only=${only}`);

  const results = [];

  for (const target of targets) {
    console.log(`\n========== ${target.name} ==========`);
    buildInPlace(target);
    const { stage, pkg } = stagePackage(target);
    console.log(`staged → ${stage}`);
    console.log(`publish name: ${pkg.name}@${pkg.version}`);

    try {
      run("npm", ["pack", "--dry-run"], stage);
      if (apply) {
        run("npm", ["publish", "--access", "public"], stage);
        results.push({ name: pkg.name, version: pkg.version, ok: true });
      } else {
        run("npm", ["publish", "--access", "public", "--dry-run"], stage);
        results.push({ name: pkg.name, version: pkg.version, ok: true, dryRun: true });
      }
    } catch (err) {
      console.error(err.message);
      results.push({ name: pkg.name, version: pkg.version, ok: false, error: err.message });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(
      `${r.ok ? "OK" : "FAIL"} ${r.name}@${r.version}${r.dryRun ? " (dry-run)" : ""}${r.error ? ` — ${r.error}` : ""}`,
    );
  }

  if (results.some((r) => !r.ok)) process.exit(1);
  if (!apply) {
    console.log("\nDry-run complete. Publish for real:");
    console.log(
      `  node scripts/publish-clawd-packages.mjs --apply --npm-scope=${npmScope || user}`,
    );
  }
}

main();
