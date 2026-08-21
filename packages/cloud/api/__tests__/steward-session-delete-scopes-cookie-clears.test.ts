/**
 * Steward session cookie clears must respect environment ownership. Production
 * owns the historical unsuffixed names on the shared parent domain; staging/dev
 * own only their suffixed names and must never delete production's live legacy
 * cookies. Post-migration (#14130), the separate legacy clear block is removed
 * because production's cookieNames already resolve to the unsuffixed names.
 */

import { describe, expect, it } from "vitest";
import app from "../auth/steward-session/route";

function deletedCookieNames(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((c) => /Max-Age=0/i.test(c))
    .map((c) => c.split("=")[0]);
}

describe("DELETE /api/auth/steward-session cookie clearing", () => {
  it("rejects a simple request without the non-simple marker", async () => {
    const res = await app.request(
      "/",
      {
        method: "DELETE",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://staging.elizacloud.ai",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "test" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "csrf_marker_required" });
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("staging clears only the staging-suffixed pair", async () => {
    const res = await app.request(
      "/",
      {
        method: "DELETE",
        headers: {
          host: "api-staging.elizacloud.ai",
          origin: "https://staging.elizacloud.ai",
          "x-eliza-csrf": "1",
        },
      },
      { ENVIRONMENT: "staging", NODE_ENV: "test" },
    );
    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token-staging");
    expect(cleared).toContain("steward-refresh-token-staging");
    expect(cleared).toContain("steward-authed-staging");
    expect(cleared).not.toContain("steward-token");
    expect(cleared).not.toContain("steward-refresh-token");
    expect(cleared).not.toContain("steward-authed");
  });

  it("production clears the historical pair (both eras resolve to the same names)", async () => {
    const res = await app.request(
      "/",
      {
        method: "DELETE",
        headers: {
          host: "api.elizacloud.ai",
          origin: "https://elizacloud.ai",
          "x-eliza-csrf": "1",
        },
      },
      { ENVIRONMENT: "production", NODE_ENV: "test" },
    );
    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token");
    expect(cleared).toContain("steward-refresh-token");
    expect(cleared).toContain("steward-authed");
  });
});
