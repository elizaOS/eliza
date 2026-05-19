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
  assertDeployable,
  deploymentIdFor,
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
