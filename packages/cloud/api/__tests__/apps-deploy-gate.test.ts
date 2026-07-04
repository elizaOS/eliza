// Exercises cloud API tests apps deploy gate.test behavior with deterministic Worker route fixtures.
import { describe, expect, test } from "bun:test";

import {
  appsDeployOrganizationDecision,
  appsDeployTriggerDecision,
  parseAppsDeployAllowedOrgIds,
} from "../src/lib/apps-deploy-gate";

describe("apps deploy production gate", () => {
  test("keeps non-production deploys unchanged when the trigger is enabled", () => {
    expect(
      appsDeployTriggerDecision({
        APPS_DEPLOY_ENABLED: "1",
        ENVIRONMENT: "staging",
      }),
    ).toEqual({ enabled: true });
    expect(
      appsDeployOrganizationDecision(
        { APPS_DEPLOY_ENABLED: "1", ENVIRONMENT: "staging" },
        "org-a",
      ),
    ).toEqual({ allowed: true });
  });

  test("fails closed in production when the trigger is enabled without an allowlist", () => {
    expect(
      appsDeployTriggerDecision({
        APPS_DEPLOY_ENABLED: "1",
        ENVIRONMENT: "production",
      }),
    ).toEqual({
      enabled: false,
      reason: "production_allowlist_missing",
    });
    expect(
      appsDeployOrganizationDecision(
        { APPS_DEPLOY_ENABLED: "1", ENVIRONMENT: "production" },
        "org-a",
      ),
    ).toEqual({
      allowed: false,
      reason: "production_allowlist_missing",
    });
  });

  test("allows only listed production organizations", () => {
    const env = {
      APPS_DEPLOY_ENABLED: "1",
      ENVIRONMENT: "production",
      APPS_DEPLOY_ALLOWED_ORG_IDS: "org-a, org-b\norg-c",
    };

    expect(parseAppsDeployAllowedOrgIds(env)).toEqual(
      new Set(["org-a", "org-b", "org-c"]),
    );
    expect(appsDeployTriggerDecision(env)).toEqual({ enabled: true });
    expect(appsDeployOrganizationDecision(env, "org-b")).toEqual({
      allowed: true,
    });
    expect(appsDeployOrganizationDecision(env, "org-z")).toEqual({
      allowed: false,
      reason: "organization_not_allowlisted",
    });
  });

  test('"*" opens deploys to every production org (full launch)', () => {
    const env = {
      APPS_DEPLOY_ENABLED: "1",
      ENVIRONMENT: "production",
      APPS_DEPLOY_ALLOWED_ORG_IDS: "*",
    };

    expect(appsDeployTriggerDecision(env)).toEqual({ enabled: true });
    expect(appsDeployOrganizationDecision(env, "org-a")).toEqual({
      allowed: true,
    });
    expect(appsDeployOrganizationDecision(env, "any-other-org")).toEqual({
      allowed: true,
    });
    // wildcard does not depend on a caller org being present
    expect(appsDeployOrganizationDecision(env, null)).toEqual({
      allowed: true,
    });
  });

  test('"*" mixed with explicit ids still allows every org', () => {
    const env = {
      APPS_DEPLOY_ENABLED: "1",
      ENVIRONMENT: "production",
      APPS_DEPLOY_ALLOWED_ORG_IDS: "org-a, *",
    };

    expect(appsDeployOrganizationDecision(env, "org-z")).toEqual({
      allowed: true,
    });
  });
});
