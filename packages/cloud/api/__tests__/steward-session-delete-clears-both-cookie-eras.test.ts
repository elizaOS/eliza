/**
 * DELETE /api/auth/steward-session must clear BOTH steward cookie naming eras
 * (env-scoped + legacy unsuffixed), mirroring /logout. This DELETE is the
 * clear path `clearStaleStewardSession` uses; if the legacy pair survives it,
 * a pre-rename staging session gets resurrected by the legacy read fallback +
 * 30-day legacy refresh cookie — a ghost session after explicit sign-out.
 * (#13728 shepherd-verification blocker.)
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
  it("staging clears the staging-suffixed AND legacy pairs", async () => {
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
    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token-staging");
    expect(cleared).toContain("steward-refresh-token-staging");
    expect(cleared).toContain("steward-token");
    expect(cleared).toContain("steward-refresh-token");
  });

  it("production clears the historical pair (both eras resolve to the same names)", async () => {
    const res = await app.request(
      "/",
      {
        method: "DELETE",
        headers: {
          host: "api.elizacloud.ai",
          origin: "https://elizacloud.ai",
        },
      },
      { ENVIRONMENT: "production", NODE_ENV: "test" },
    );
    expect(res.status).toBe(200);
    const cleared = deletedCookieNames(res);
    expect(cleared).toContain("steward-token");
    expect(cleared).toContain("steward-refresh-token");
  });
});
