// Exercises the appsDeployRequireDigest gate (#13097): the immutable-image lane
// is ON by default, an operator may opt out with APPS_DEPLOY_REQUIRE_DIGEST=false
// in non-production only, and a production opt-out is refused so a deployed
// binding cannot silently reopen mutable apps. Pure (env) => boolean.
import { describe, expect, test } from "bun:test";
import { containersEnv } from "../containers-env";

describe("appsDeployRequireDigest (#13097)", () => {
  test("defaults to true (immutable is the safe direction)", () => {
    expect(containersEnv.appsDeployRequireDigest({})).toBe(true);
  });

  test("false opt-out honored in non-production (no ENVIRONMENT)", () => {
    expect(containersEnv.appsDeployRequireDigest({ APPS_DEPLOY_REQUIRE_DIGEST: "false" })).toBe(
      false,
    );
    expect(containersEnv.appsDeployRequireDigest({ APPS_DEPLOY_REQUIRE_DIGEST: "0" })).toBe(false);
  });

  test("false opt-out honored in staging (ENVIRONMENT=staging)", () => {
    expect(
      containersEnv.appsDeployRequireDigest({
        APPS_DEPLOY_REQUIRE_DIGEST: "false",
        ENVIRONMENT: "staging",
      }),
    ).toBe(false);
  });

  test("false opt-out REFUSED in production (ENVIRONMENT=production)", () => {
    expect(
      containersEnv.appsDeployRequireDigest({
        APPS_DEPLOY_REQUIRE_DIGEST: "false",
        ENVIRONMENT: "production",
      }),
    ).toBe(true);
  });

  test("false opt-out REFUSED in production (NODE_ENV=production fallback)", () => {
    expect(
      containersEnv.appsDeployRequireDigest({
        APPS_DEPLOY_REQUIRE_DIGEST: "false",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  test("true explicitly enables the gate", () => {
    expect(containersEnv.appsDeployRequireDigest({ APPS_DEPLOY_REQUIRE_DIGEST: "true" })).toBe(
      true,
    );
    expect(containersEnv.appsDeployRequireDigest({ APPS_DEPLOY_REQUIRE_DIGEST: "1" })).toBe(true);
  });

  test("ENVIRONMENT takes priority over NODE_ENV (staging worker with NODE_ENV=production still allows opt-out)", () => {
    expect(
      containersEnv.appsDeployRequireDigest({
        APPS_DEPLOY_REQUIRE_DIGEST: "false",
        ENVIRONMENT: "staging",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });
});

describe("appDefaultTemplateImage (#13097 digest pin)", () => {
  test("default is now digest-pinned, not a mutable tag", () => {
    // Clear the env override so the default is used.
    const defaultImage = containersEnv.appDefaultTemplateImage();
    expect(defaultImage).toContain("@sha256:");
    expect(defaultImage).not.toMatch(/:showcase$/);
  });
});
