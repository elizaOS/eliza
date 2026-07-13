import { describe, expect, it } from "vitest";
import { healthForProbeStatus } from "./accounts-routes";

describe("account usage probe health classification", () => {
  it("keeps invalidated OAuth tokens in needs-reauth instead of rate-limited", () => {
    expect(healthForProbeStatus(401)).toBe("needs-reauth");
    expect(healthForProbeStatus(403)).toBe("needs-reauth");
  });

  it("reserves rate-limited for an actual 429", () => {
    expect(healthForProbeStatus(429)).toBe("rate-limited");
  });
});
