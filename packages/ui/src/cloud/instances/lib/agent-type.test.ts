import { describe, expect, it } from "vitest";
import { getUserFacingAgentType } from "./agent-type";

describe("getUserFacingAgentType", () => {
  it("exposes exactly Shared Agent and Dedicated Agent product types", () => {
    expect(getUserFacingAgentType("shared")).toBe("Shared Agent");
    expect(getUserFacingAgentType("dedicated-lazy")).toBe("Dedicated Agent");
    expect(getUserFacingAgentType("dedicated-always")).toBe("Dedicated Agent");
    expect(getUserFacingAgentType("custom")).toBe("Dedicated Agent");
  });
});
