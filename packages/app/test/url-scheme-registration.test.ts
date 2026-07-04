/**
 * Unit tests for the Url Scheme Registration app shell contract and coverage
 * guardrail.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Device-free contract for the mobile deep-link / cloud-auth-callback wiring.
 *
 * The `elizaos://` custom URL scheme is how the cloud SSO callback and every
 * deep link re-enter the app. If the Android manifest's scheme registration
 * drifts from `app.config.ts` (urlScheme / appId), auth callbacks and deep
 * links silently fail to resolve to the app — a class of breakage that today
 * only surfaces on a real device. This asserts the registration statically,
 * against the repo's own files (no simulator, no wrapper app dir).
 *
 * iOS is intentionally not asserted here: `packages/app/ios/` is
 * Capacitor-generated and gitignored, so there is no in-repo Info.plist to
 * check. The simulator-based iOS plist assertion lives in
 * `mobile-auth-simulator-smoke.mjs` (needs a synced ios/ project).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const androidMain = path.resolve(
  here,
  "../../app-core/platforms/android/app/src/main",
);

const read = (p: string): string => readFileSync(p, "utf8");

const appConfig = read(path.join(appRoot, "app.config.ts"));
const manifest = read(path.join(androidMain, "AndroidManifest.xml"));
const strings = read(path.join(androidMain, "res/values/strings.xml"));

const urlScheme = appConfig.match(/urlScheme:\s*"([^"]+)"/)?.[1];
const appId = appConfig.match(/appId:\s*"([^"]+)"/)?.[1];
const customScheme = strings.match(
  /<string name="custom_url_scheme">([^<]+)<\/string>/,
)?.[1];
const packageName = strings.match(
  /<string name="package_name">([^<]+)<\/string>/,
)?.[1];

describe("mobile URL-scheme / deep-link registration contract", () => {
  it("app.config declares the elizaos urlScheme and ai.elizaos.app appId", () => {
    expect(urlScheme).toBe("elizaos");
    expect(appId).toBe("ai.elizaos.app");
  });

  it("android custom_url_scheme matches app.config urlScheme", () => {
    expect(customScheme).toBe(urlScheme);
  });

  it("android package_name matches app.config appId", () => {
    expect(packageName).toBe(appId);
  });

  it("manifest registers a VIEW/DEFAULT/BROWSABLE deep-link intent-filter bound to custom_url_scheme", () => {
    const deepLinkFilter = [
      ...manifest.matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g),
    ]
      .map((m) => m[1])
      .find((body) =>
        body.includes('android:scheme="@string/custom_url_scheme"'),
      );

    expect(
      deepLinkFilter,
      "no intent-filter binds @string/custom_url_scheme",
    ).toBeTruthy();
    expect(deepLinkFilter).toContain("android.intent.action.VIEW");
    expect(deepLinkFilter).toContain("android.intent.category.DEFAULT");
    expect(deepLinkFilter).toContain("android.intent.category.BROWSABLE");
  });
});
