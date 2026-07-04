/**
 * Unit coverage for the mobile-auth-simulator-smoke deep-link target
 * resolution (#13583). Guards against the wrong-target footgun where a nested
 * elizaOS checkout resolves to the OUTER consumer app (firing e.g.
 * `milady://auth/callback` instead of this repo's `elizaos://`), and against
 * the fire-and-forget deep-link leg that never asserted which package handled
 * the intent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCallbackUrl,
  expectedAuthCallbackFromUrl,
  parseArgs,
  parseResolvedActivity,
  resolvedActivityMatchesApp,
  resolveTargetAppDir,
} from "../../scripts/mobile-auth-simulator-smoke.mjs";

const ELIZA_APP_ID = "ai.elizaos.app";
const CONSUMER_APP_ID = "com.milady.app";

describe("mobile-auth-simulator-smoke: resolve-activity assertion", () => {
  it("parses the --brief bare component line", () => {
    // `resolve-activity --brief` prints the component on its own line.
    expect(
      parseResolvedActivity(
        "Intent { act=android.intent.action.VIEW dat=elizaos://auth/callback }\nai.elizaos.app/.MainActivity",
      ),
    ).toBe("ai.elizaos.app/.MainActivity");
  });

  it("prefers packageName= over the activity-class name= (codex P1)", () => {
    // REGRESSION for the codex P1: in verbose ResolveInfo output `name=` is the
    // ACTIVITY CLASS (e.g. `.MainActivity`), NOT the package. Parsing `name=`
    // first would reject a correctly-registered app. packageName= is the
    // authoritative package identity and must win.
    const verbose =
      "ResolveInfo{... priority=0 name=.MainActivity packageName=ai.elizaos.app match=0x108000 ...}";
    expect(parseResolvedActivity(verbose)).toBe("ai.elizaos.app");
    expect(
      resolvedActivityMatchesApp(parseResolvedActivity(verbose), ELIZA_APP_ID),
    ).toBe(true);
  });

  it("captures the inline <pkg>/<activity> component from verbose output", () => {
    expect(
      parseResolvedActivity(
        "ActivityInfo: ai.elizaos.app/ai.elizaos.app.MainActivity flags=0x0",
      ),
    ).toBe("ai.elizaos.app/ai.elizaos.app.MainActivity");
  });

  it("returns empty string when nothing handles the intent", () => {
    expect(parseResolvedActivity("No activity found")).toBe("");
    expect(parseResolvedActivity("")).toBe("");
  });

  it("accepts the expected package (fully-qualified component)", () => {
    expect(
      resolvedActivityMatchesApp("ai.elizaos.app/.MainActivity", ELIZA_APP_ID),
    ).toBe(true);
  });

  it("accepts the expected package (bare package name)", () => {
    expect(resolvedActivityMatchesApp("ai.elizaos.app", ELIZA_APP_ID)).toBe(
      true,
    );
  });

  it("REGRESSION: rejects a consumer app claiming the same-shaped scheme", () => {
    // The exact wrong-target failure mode: the deep link resolves to the
    // consumer's MainActivity, not this repo's. Previously fire-and-forget so
    // this exited 0 silently; the resolve-activity preflight must reject it.
    expect(
      resolvedActivityMatchesApp("com.milady.app/.MainActivity", ELIZA_APP_ID),
    ).toBe(false);
    // Guard against a prefix-collision false-accept (ai.elizaos.app.other).
    expect(
      resolvedActivityMatchesApp("ai.elizaos.app.demo/.Main", ELIZA_APP_ID),
    ).toBe(false);
    expect(resolvedActivityMatchesApp("", ELIZA_APP_ID)).toBe(false);
  });
});

describe("mobile-auth-simulator-smoke: callback URL + args", () => {
  it("builds the callback URL from the app's own scheme", () => {
    expect(
      buildCallbackUrl(
        { urlScheme: "elizaos" },
        { path: "auth/callback", query: "state=s&code=c", url: "" },
      ),
    ).toBe("elizaos://auth/callback?state=s&code=c");
  });

  it("extracts expected iOS auth callback handling fields from the opened URL", () => {
    expect(
      expectedAuthCallbackFromUrl(
        "elizaos://auth/callback?state=simulator-oauth-state&code=simulator-oauth-code&extra=1",
      ),
    ).toEqual({
      path: "auth/callback",
      state: "simulator-oauth-state",
      code: "simulator-oauth-code",
    });
  });

  it("honors a full --url override and normalizes leading slashes / ?", () => {
    expect(
      buildCallbackUrl(
        { urlScheme: "elizaos" },
        { path: "///auth/callback", query: "?code=c", url: "" },
      ),
    ).toBe("elizaos://auth/callback?code=c");
    expect(
      buildCallbackUrl(
        { urlScheme: "elizaos" },
        { path: "auth/callback", query: "", url: "custom://override" },
      ),
    ).toBe("custom://override");
  });

  it("parses the new --app-dir flag", () => {
    const opts = parseArgs(["--platform", "android", "--app-dir", "/some/app"]);
    expect(opts.platform).toBe("android");
    expect(opts.appDir).toBe("/some/app");
  });
});

describe("mobile-auth-simulator-smoke: target app-dir resolution (#13583)", () => {
  let tmpRoot: string;
  let prevPin: string | undefined;

  /** Lay down a minimal repo tree with packages/app/package.json + app.config.ts. */
  function writeAppTree(root: string, appId: string, scheme: string) {
    const appDir = path.join(root, "packages", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "package.json"), "{}");
    writeFileSync(
      path.join(appDir, "app.config.ts"),
      `export default { appId: "${appId}", appName: "Demo", urlScheme: "${scheme}" };\n`,
    );
    return appDir;
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "auth-smoke-13583-"));
    prevPin = process.env.ELIZA_MOBILE_REPO_ROOT;
    delete process.env.ELIZA_MOBILE_REPO_ROOT;
  });

  afterEach(() => {
    if (prevPin === undefined) delete process.env.ELIZA_MOBILE_REPO_ROOT;
    else process.env.ELIZA_MOBILE_REPO_ROOT = prevPin;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("--app-dir wins over everything and reports its source", () => {
    const explicit = path.join(tmpRoot, "explicit", "app");
    mkdirSync(explicit, { recursive: true });
    process.env.ELIZA_MOBILE_REPO_ROOT = path.join(tmpRoot, "pinned");
    const resolved = resolveTargetAppDir(explicit);
    expect(resolved.appDir).toBe(explicit);
    expect(resolved.source).toBe("--app-dir");
  });

  it("ELIZA_MOBILE_REPO_ROOT pins the target to that checkout's own app", () => {
    // This is the core #13583 fix: two sibling checkouts (this repo + a
    // consumer) each pin to their OWN root and deterministically get their own
    // appId/scheme instead of walking up to the wrong one.
    const elizaRoot = path.join(tmpRoot, "eliza");
    const consumerRoot = path.join(tmpRoot, "consumer");
    writeAppTree(elizaRoot, ELIZA_APP_ID, "elizaos");
    writeAppTree(consumerRoot, CONSUMER_APP_ID, "milady");

    process.env.ELIZA_MOBILE_REPO_ROOT = elizaRoot;
    const pinnedEliza = resolveTargetAppDir("");
    expect(pinnedEliza.source).toBe("ELIZA_MOBILE_REPO_ROOT");
    expect(pinnedEliza.appDir).toBe(path.join(elizaRoot, "packages", "app"));

    process.env.ELIZA_MOBILE_REPO_ROOT = consumerRoot;
    const pinnedConsumer = resolveTargetAppDir("");
    expect(pinnedConsumer.appDir).toBe(
      path.join(consumerRoot, "packages", "app"),
    );
  });

  it("falls back to the repo-root walk when no pin is provided", () => {
    // Consumer-safety: without a pin the default consumer-friendly resolution
    // is preserved (source = repo-root-walk), so running from a consumer root
    // still targets the consumer.
    const resolved = resolveTargetAppDir("");
    expect(resolved.source).toBe("repo-root-walk");
    expect(typeof resolved.appDir).toBe("string");
  });
});
