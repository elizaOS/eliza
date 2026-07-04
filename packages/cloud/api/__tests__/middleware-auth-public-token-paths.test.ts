/**
 * Unit tests for the out-of-band token-page public-path allowlist in
 * `middleware/auth.ts`.
 *
 * The sensitive-request / approval-signer / ballot links are visited by
 * sessionless recipients. The global auth gate must let the signer-facing
 * subpaths through (the route handlers then enforce the token / signature),
 * while the per-org list / create / admin endpoints on the same resources stay
 * gated. These are pure predicate tests — no Worker, no DB.
 */

import { describe, expect, test } from "bun:test";

import { isPublicPath } from "../src/middleware/auth";

describe("isPublicPath — out-of-band token pages", () => {
  test("sensitive-request detail + submit are public (token-gated by handler)", () => {
    expect(isPublicPath("/api/v1/sensitive-requests/req-123")).toBe(true);
    expect(isPublicPath("/api/v1/sensitive-requests/req-123/submit")).toBe(
      true,
    );
  });

  test("sensitive-request create / cancel / expire stay gated", () => {
    expect(isPublicPath("/api/v1/sensitive-requests")).toBe(false);
    expect(isPublicPath("/api/v1/sensitive-requests/req-123/cancel")).toBe(
      false,
    );
    expect(isPublicPath("/api/v1/sensitive-requests/req-123/expire")).toBe(
      false,
    );
  });

  test("approval-request detail + approve + deny are public (signer-facing)", () => {
    expect(isPublicPath("/api/v1/approval-requests/ap-1")).toBe(true);
    expect(isPublicPath("/api/v1/approval-requests/ap-1/approve")).toBe(true);
    expect(isPublicPath("/api/v1/approval-requests/ap-1/deny")).toBe(true);
  });

  test("approval-request list / create / cancel stay gated", () => {
    expect(isPublicPath("/api/v1/approval-requests")).toBe(false);
    expect(isPublicPath("/api/v1/approval-requests/ap-1/cancel")).toBe(false);
  });

  test("ballot detail + vote are public (token-gated by handler)", () => {
    expect(isPublicPath("/api/v1/ballots/b-1")).toBe(true);
    expect(isPublicPath("/api/v1/ballots/b-1/vote")).toBe(true);
  });

  test("ballot list / create / tally / distribute / cancel stay gated", () => {
    expect(isPublicPath("/api/v1/ballots")).toBe(false);
    expect(isPublicPath("/api/v1/ballots/b-1/tally")).toBe(false);
    expect(isPublicPath("/api/v1/ballots/b-1/distribute")).toBe(false);
    expect(isPublicPath("/api/v1/ballots/b-1/cancel")).toBe(false);
  });

  test("does not over-match unrelated nested paths", () => {
    expect(isPublicPath("/api/v1/sensitive-requests/req-123/audit")).toBe(
      false,
    );
    expect(isPublicPath("/api/v1/ballots/b-1/results/extra")).toBe(false);
    expect(isPublicPath("/api/v1/approval-requests/ap-1/approve/extra")).toBe(
      false,
    );
  });

  test("campaign report public token route is public but report management stays gated", () => {
    expect(isPublicPath("/api/v1/advertising/reports/share-token-1")).toBe(
      true,
    );
    expect(
      isPublicPath("/api/v1/advertising/campaigns/campaign-1/report"),
    ).toBe(false);
    expect(
      isPublicPath("/api/v1/advertising/campaigns/campaign-1/report/share"),
    ).toBe(false);
  });
});

describe("isPublicPath — removed dead eliza-app gateway (#12043)", () => {
  test("the unauthenticated canned-echo gateway is no longer public", () => {
    // The demo `/api/eliza-app/gateway/:agentId` echo route and its allowlist
    // entry were removed; the path must not resolve as public any more.
    expect(isPublicPath("/api/eliza-app/gateway/agent-1")).toBe(false);
    expect(isPublicPath("/api/eliza-app/gateway")).toBe(false);
  });

  test("the real eliza-app public paths are untouched", () => {
    expect(isPublicPath("/api/eliza-app/auth/discord")).toBe(true);
    expect(isPublicPath("/api/eliza-app/connections/discord/initiate")).toBe(
      true,
    );
    expect(isPublicPath("/api/eliza-app/cli-auth/init")).toBe(true);
    expect(isPublicPath("/api/eliza-app/onboarding")).toBe(true);
  });
});
