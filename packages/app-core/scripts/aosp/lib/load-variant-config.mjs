#!/usr/bin/env node
// Read the host app's `app.config.ts` and extract the `aosp:` variant
// block via regex. Mirrors `run-mobile-build.mjs:readAppIdentity()` —
// build-time scripts never TS-import `app.config.ts` because they have
// to run under bare node before any build step has produced the
// transpiled JS.
//
// Returns:
//   - the parsed `AospVariantConfig` object on success,
//   - `null` when `app.config.ts` exists but has no `aosp:` block (the
//     fork doesn't ship an AOSP image — toolkit scripts treat this as
//     "nothing to do" and exit 0),
//   - throws when `app.config.ts` cannot be read or is malformed.

import fs from "node:fs";
import path from "node:path";

/**
 * Load the AOSP variant config from a host app's `app.config.ts`.
 *
 * @param {object} options
 * @param {string} options.appConfigPath  Absolute path to app.config.ts.
 *                                        Caller resolves relative to
 *                                        the host's main app dir.
 * @returns {object|null}
 */
export function loadAospVariantConfig({ appConfigPath }) {
  if (!fs.existsSync(appConfigPath)) {
    throw new Error(
      `[aosp] app.config.ts not found at ${appConfigPath}. ` +
        `Pass --app-config <PATH> if your config lives elsewhere.`,
    );
  }
  const src = fs.readFileSync(appConfigPath, "utf8");

  // Find the `aosp: { ... }` block. Use a balanced-brace scan so nested
  // objects (none today, but reserved) don't trip a greedy regex.
  const blockBody = extractObjectBlockBody(src, "aosp");
  if (blockBody === null) {
    // Fork without an AOSP image. The caller decides whether that's an
    // error or a no-op.
    return null;
  }

  const productLunch = matchString(blockBody, "productLunch");
  const vendorDir = matchString(blockBody, "vendorDir");
  const variantName = matchString(blockBody, "variantName");
  const productName = matchString(blockBody, "productName");
  const packageName = matchString(blockBody, "packageName");
  const appName = matchString(blockBody, "appName");
  const commonMk = matchString(blockBody, "commonMk");
  const modelSourceLabel = matchString(blockBody, "modelSourceLabel");
  const bootanimationAssetDir = matchString(blockBody, "bootanimationAssetDir");
  const cuttlefishDeviceDir = matchString(blockBody, "cuttlefishDeviceDir");
  const propertyPrefix = matchString(blockBody, "propertyPrefix");

  const required = {
    productLunch,
    vendorDir,
    variantName,
    productName,
    packageName,
    appName,
    commonMk,
    modelSourceLabel,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `[aosp] app.config.ts > aosp: block is missing required field(s): ` +
        `${missing.join(", ")}. See AospVariantConfig in @elizaos/app-core.`,
    );
  }

  return {
    productLunch,
    vendorDir,
    variantName,
    productName,
    packageName,
    appName,
    commonMk,
    modelSourceLabel,
    // System-property prefix used by `init.<vendorDir>.rc` (e.g.
    // `miladyos.boot_phase`, `elizaos.boot_phase`). Defaults to the
    // vendor dir when forks haven't customized — that's the common
    // Android convention. Forks like Milady whose property namespace
    // differs from the vendor dir name (vendor=milady, props=miladyos)
    // declare it explicitly.
    propertyPrefix: propertyPrefix ?? vendorDir,
    bootanimationAssetDir: bootanimationAssetDir ?? undefined,
    cuttlefishDeviceDir: cuttlefishDeviceDir ?? undefined,
  };
}

/**
 * Resolve an `app.config.ts` path. CLI flag wins; otherwise default to
 * `<repoRoot>/apps/app/app.config.ts` (the elizaOS host convention).
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string|null|undefined} options.flagValue  The value passed
 *                                                   to --app-config.
 * @returns {string}  Absolute path to app.config.ts.
 */
export function resolveAppConfigPath({ repoRoot, flagValue }) {
  if (flagValue) return path.resolve(flagValue);
  return path.join(repoRoot, "apps", "app", "app.config.ts");
}

/**
 * Walk the source from the start of `<key>:` looking for a matching
 * pair of braces. Returns the inner text (between the outer `{` and
 * `}`) or `null` when the key is not present.
 *
 * Handles nested braces, simple string-literal escapes, and line
 * comments (// ...). Does NOT handle block comments inside the body —
 * `app.config.ts` doesn't ship those today, and rejecting them is
 * fine.
 */
function extractObjectBlockBody(src, key) {
  const re = new RegExp(`\\b${key}\\s*:\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length; // position of the char after `{`
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return src.slice(start, i);
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    i += 1;
  }
  throw new Error(
    `[aosp] Could not parse app.config.ts: unbalanced braces in \`${key}:\` block.`,
  );
}

function skipStringLiteral(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  throw new Error(
    `[aosp] Could not parse app.config.ts: unterminated string literal.`,
  );
}

function matchString(body, key) {
  const re = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`);
  const m = re.exec(body);
  return m ? m[1] : null;
}
