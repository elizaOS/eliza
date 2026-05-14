/**
 * iOS App Store entitlement lockdown.
 *
 * iOS App Store review rejects any binary that declares the macOS Hardened
 * Runtime "cs.*" entitlements. These three keys in particular are blocked:
 *
 *   - com.apple.security.cs.allow-jit
 *       JIT in third-party iOS apps is prohibited by App Review. The key
 *       itself is macOS-only; iOS silently ignores it but App Store Connect
 *       still flags it on upload.
 *
 *   - com.apple.security.cs.allow-unsigned-executable-memory
 *       Same family as allow-jit; iOS does not support unsigned executable
 *       memory and App Review treats the entitlement as a JIT signal.
 *
 *   - com.apple.security.cs.disable-library-validation
 *       Disables code-signing checks on dynamic libraries. macOS Hardened
 *       Runtime only; meaningless and forbidden on iOS.
 *
 * Today's iOS app is a Capacitor thin client. The agent runs in Eliza Cloud,
 * so no JIT is needed and the iOS entitlements file does not (and must not)
 * declare any of these three keys. This test guards against future regression
 * by scanning every iOS-region `.entitlements` file it can reach and failing
 * if any forbidden key is set, or if any `com.apple.security.cs.*` key is
 * declared at all (those entitlements only exist on macOS).
 *
 * The same iOS entitlements template is shared between the App Store
 * (`ios`) and sideload (`ios-local`) build variants — see
 * `packages/app-core/scripts/run-mobile-build.mjs` `resolveMobileBuildPolicy`.
 * Local development on iOS does not require JIT either (the Capacitor host
 * uses JavaScriptCore from the system, not Bun), so keeping the policy
 * variant-agnostic is correct.
 *
 * Doc note: the human-readable section in the milady parent's
 * `docs/sandbox-mode.md` ("iOS App Store entitlement lockdown") is owned by
 * the parent repository. When editing this test, mirror the change there.
 * That doc lives outside this worktree's branch boundary and is updated by
 * a separate commit on the milady parent repo.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_CORE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const FORBIDDEN_KEYS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
] as const;

const FORBIDDEN_NAMESPACE_PREFIX = "com.apple.security.cs.";

/**
 * Candidate iOS-region roots, in order. The test scans every root that
 * exists on disk and skips the rest silently. Worktree may live under a
 * milady parent (preferred) or stand alone (eliza repo only).
 */
function candidateIosRoots(): readonly string[] {
  const roots: string[] = [];
  // 1. The shared iOS entitlements template inside the eliza app-core
  //    package. This is the canonical source copied into the generated
  //    Capacitor iOS project at build time.
  roots.push(join(APP_CORE_ROOT, "platforms", "ios"));
  // 2. The milady parent repo's generated iOS Capacitor project, if this
  //    worktree happens to sit inside one. We walk up the directory tree
  //    looking for an ancestor that contains `apps/app/ios` — that pattern
  //    uniquely identifies the milady parent root. Bounded to 12 hops so
  //    the loop terminates on filesystems with unusual layouts.
  const miladyAppIos = findAncestorWithChildPath(
    APP_CORE_ROOT,
    join("apps", "app", "ios"),
    12,
  );
  if (miladyAppIos !== null) {
    roots.push(miladyAppIos);
  }
  return roots;
}

function findAncestorWithChildPath(
  start: string,
  childRelPath: string,
  maxHops: number,
): string | null {
  let current = start;
  for (let i = 0; i < maxHops; i++) {
    const candidate = join(current, childRelPath);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const next = dirname(current);
    if (next === current) return null;
    current = next;
  }
  return null;
}

function walkForEntitlements(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries: string[] = readdirSync(dir);
    for (const name of entries) {
      if (
        name === "node_modules" ||
        name === "Pods" ||
        name === "build" ||
        name === "DerivedData" ||
        name === ".git"
      ) {
        continue;
      }
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && name.endsWith(".entitlements")) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Extracts every `<key>X</key>` whose immediately-following sibling element
 * is `<true/>` from an entitlements plist. This is the only shape boolean
 * entitlements take; entitlements declared `<false/>` or as arrays/strings
 * are irrelevant for the JIT lockdown.
 *
 * Hand-written rather than pulling in a plist parser dependency: the plist
 * surface for entitlements is tiny and well-formed; a targeted regex is
 * deterministic and avoids adding a transitive package for one test.
 */
function trueKeys(plistXml: string): string[] {
  const stripped = plistXml.replace(/<!--[\s\S]*?-->/g, "");
  const pattern =
    /<key>\s*([^<]+?)\s*<\/key>\s*<(true|false)\s*\/>/g;
  const keys: string[] = [];
  for (const match of stripped.matchAll(pattern)) {
    const key = match[1];
    const value = match[2];
    if (typeof key === "string" && value === "true") {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Extracts every `<key>X</key>` regardless of value type. Used to catch any
 * `com.apple.security.cs.*` declaration even if someone tries to set it to
 * `<false/>` or wrap it in an array — the namespace itself does not belong
 * in an iOS entitlements file.
 */
function allKeys(plistXml: string): string[] {
  const stripped = plistXml.replace(/<!--[\s\S]*?-->/g, "");
  const pattern = /<key>\s*([^<]+?)\s*<\/key>/g;
  const keys: string[] = [];
  for (const match of stripped.matchAll(pattern)) {
    const key = match[1];
    if (typeof key === "string") {
      keys.push(key);
    }
  }
  return keys;
}

interface AuditedFile {
  readonly path: string;
  readonly trueKeys: readonly string[];
  readonly allKeys: readonly string[];
}

function auditIosEntitlements(): readonly AuditedFile[] {
  const files: AuditedFile[] = [];
  for (const root of candidateIosRoots()) {
    for (const entitlementsPath of walkForEntitlements(root)) {
      const xml = readFileSync(entitlementsPath, "utf8");
      files.push({
        path: entitlementsPath,
        trueKeys: trueKeys(xml),
        allKeys: allKeys(xml),
      });
    }
  }
  return files;
}

describe("iOS App Store entitlement lockdown", () => {
  it("never declares forbidden JIT / unsigned-memory / library-validation keys", () => {
    const audited = auditIosEntitlements();
    const offenders: string[] = [];
    for (const file of audited) {
      for (const forbidden of FORBIDDEN_KEYS) {
        if (file.trueKeys.includes(forbidden)) {
          offenders.push(`${file.path}: declares ${forbidden} = true`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never declares any com.apple.security.cs.* (macOS-only) entitlement", () => {
    const audited = auditIosEntitlements();
    const offenders: string[] = [];
    for (const file of audited) {
      for (const key of file.allKeys) {
        if (key.startsWith(FORBIDDEN_NAMESPACE_PREFIX)) {
          offenders.push(`${file.path}: declares macOS-only key ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("audits at least one iOS entitlements file in the eliza source tree", () => {
    // Guard against the test silently passing because the file-walk
    // pattern broke and audited zero files. The eliza repo always ships
    // the App.entitlements template under packages/app-core/platforms/ios.
    const audited = auditIosEntitlements();
    const elizaSourced = audited.filter((f) =>
      f.path.startsWith(APP_CORE_ROOT),
    );
    expect(elizaSourced.length).toBeGreaterThan(0);
  });
});
