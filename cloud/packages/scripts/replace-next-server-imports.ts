#!/usr/bin/env bun
/**
 * Replaces `next/server` usage with Web Fetch API types (`Request`, `Response`)
 * for Cloudflare Workers compatibility. Removes `from "next/server"` imports.
 *
 * Skips `packages/lib/api/errors.ts` (local `NextResponse` alias for exports).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

const repoRoot = resolve(import.meta.dir, "../..");
const SKIP_IDENTIFIER_REPLACE = new Set([
  normalizePath(resolve(repoRoot, "packages/lib/api/errors.ts")),
]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name.startsWith(".next")) {
      continue;
    }
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) yield p;
  }
}

function removeNextServerImports(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*import[\s\S]*\bfrom\s+["']next\/server["']\s*;\s*$/.test(line))
    .join("\n");
}

function transformFile(absPath: string): boolean {
  let s = readFileSync(absPath, "utf8");
  const original = s;
  const hadNextServerImport = /from\s+["']next\/server["']/.test(s);

  if (hadNextServerImport) {
    s = removeNextServerImports(s);
  }

  const key = normalizePath(absPath);
  if (!SKIP_IDENTIFIER_REPLACE.has(key)) {
    s = s.replace(/\brequest\.nextUrl\b/g, "new URL(request.url)");
    s = s.replace(/\breq\.nextUrl\b/g, "new URL(req.url)");
    s = s.replace(/\bNextRequest\b/g, "Request");
    s = s.replace(/\bNextResponse\b/g, "Response");
  }

  if (s !== original) {
    writeFileSync(absPath, s);
    return true;
  }
  return false;
}

let updated = 0;
for (const f of walk(repoRoot)) {
  if (transformFile(f)) updated++;
}
console.log(`[replace-next-server-imports] updated ${updated} files`);
