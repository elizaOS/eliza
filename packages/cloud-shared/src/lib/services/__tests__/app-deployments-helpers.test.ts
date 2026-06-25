/**
 * Covers the pure helpers backing the app-deployments service:
 *
 *   - `publicStatusFor` — db enum → CLI-facing status
 *   - `deploymentIdFor` — `<appId>:<iso-timestamp>` formatter
 *   - `assertDeployable` — 409 guard against concurrent deploys
 */
import { describe, expect, test } from "bun:test";
import { ApiError } from "../../api/cloud-worker-errors";
import {
  appKindFor,
  assertDeployable,
  deploymentIdFor,
  isLocalApp,
  isRemoteApp,
  publicStatusFor,
} from "../app-deployments-helpers";

describe("publicStatusFor", () => {
  test("maps draft to DRAFT", () => {
    expect(publicStatusFor("draft")).toBe("DRAFT");
  });
  test("collapses building and deploying to BUILDING", () => {
    expect(publicStatusFor("building")).toBe("BUILDING");
    expect(publicStatusFor("deploying")).toBe("BUILDING");
  });
  test("maps deployed to READY", () => {
    expect(publicStatusFor("deployed")).toBe("READY");
  });
  test("maps failed to ERROR", () => {
    expect(publicStatusFor("failed")).toBe("ERROR");
  });
});

describe("deploymentIdFor", () => {
  test("uses ISO timestamp when last_deployed_at is set", () => {
    const ts = new Date("2026-05-19T15:00:00.000Z");
    expect(deploymentIdFor({ id: "app_1", last_deployed_at: ts })).toBe(
      "app_1:2026-05-19T15:00:00.000Z",
    );
  });
  test("uses 0 sentinel when last_deployed_at is null", () => {
    expect(deploymentIdFor({ id: "app_2", last_deployed_at: null })).toBe("app_2:0");
  });
  // Regression (#9300): a cached `appsService.getById` read round-trips the
  // timestamp through JSON, so `last_deployed_at` arrives as an ISO STRING.
  // Calling `.toISOString()` on it threw → the deploy-status route 500'd on
  // real staging. The helper must coerce a string the same as a Date.
  test("coerces an ISO-string last_deployed_at (cached read) without throwing", () => {
    expect(
      deploymentIdFor({
        id: "app_3",
        last_deployed_at: "2026-05-19T15:00:00.000Z",
      }),
    ).toBe("app_3:2026-05-19T15:00:00.000Z");
  });
});

describe("assertDeployable", () => {
  test("throws ApiError(409) when status is building", () => {
    expect(() => assertDeployable({ deployment_status: "building" })).toThrow(ApiError);
    try {
      assertDeployable({ deployment_status: "building" });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).code).toBe("session_not_ready");
    }
  });

  test("does not throw for draft / deployed / failed / deploying", () => {
    expect(() => assertDeployable({ deployment_status: "draft" })).not.toThrow();
    expect(() => assertDeployable({ deployment_status: "deployed" })).not.toThrow();
    expect(() => assertDeployable({ deployment_status: "failed" })).not.toThrow();
    // `deploying` is the immediate-after-build state — callers may want to
    // retry from a fresh deploy after a deploy-side failure during upload,
    // so we don't reject it here.
    expect(() => assertDeployable({ deployment_status: "deploying" })).not.toThrow();
  });
});

describe("appKindFor / isLocalApp / isRemoteApp (#9145)", () => {
  test("draft app with no production_url is local", () => {
    expect(appKindFor({ deployment_status: "draft", production_url: null })).toBe("local");
    expect(isLocalApp({ deployment_status: "draft", production_url: null })).toBe(true);
    expect(isRemoteApp({ deployment_status: "draft", production_url: null })).toBe(false);
  });

  test("deployed app is remote even if production_url is somehow null", () => {
    expect(appKindFor({ deployment_status: "deployed", production_url: null })).toBe("remote");
    expect(isRemoteApp({ deployment_status: "deployed", production_url: null })).toBe(true);
  });

  test("deployed app with production_url is remote", () => {
    expect(
      appKindFor({
        deployment_status: "deployed",
        production_url: "https://app.example.com",
      }),
    ).toBe("remote");
  });

  test("building/deploying app with a production_url already assigned is remote", () => {
    expect(
      appKindFor({
        deployment_status: "building",
        production_url: "https://app.example.com",
      }),
    ).toBe("remote");
    expect(
      appKindFor({
        deployment_status: "deploying",
        production_url: "https://app.example.com",
      }),
    ).toBe("remote");
  });

  test("building/deploying app without a production_url is still local", () => {
    expect(appKindFor({ deployment_status: "building", production_url: null })).toBe("local");
    expect(appKindFor({ deployment_status: "deploying", production_url: null })).toBe("local");
    expect(appKindFor({ deployment_status: "building", production_url: "" })).toBe("local");
  });

  test("failed app is local (no live container, even with a stale url)", () => {
    expect(appKindFor({ deployment_status: "failed", production_url: null })).toBe("local");
    expect(
      appKindFor({
        deployment_status: "failed",
        production_url: "https://old.example.com",
      }),
    ).toBe("local");
  });
});
