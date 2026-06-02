import { describe, expect, it } from "vitest";
import {
  buildLifeOpsHash,
  LIFEOPS_ROUTE_SECTIONS,
  parseLifeOpsRoute,
} from "./lifeops-route.js";

describe("LifeOps route sections", () => {
  it("includes assistant as a first-class section", () => {
    expect(LIFEOPS_ROUTE_SECTIONS[0]).toBe("assistant");
    expect(LIFEOPS_ROUTE_SECTIONS).toContain("assistant");
  });

  it("parses and serializes assistant deep links", () => {
    const hash = buildLifeOpsHash("", { section: "assistant" });

    expect(hash).toBe("#lifeops.section=assistant");
    expect(parseLifeOpsRoute(hash)).toMatchObject({
      section: "assistant",
      eventId: null,
      messageId: null,
    });
  });

  it("keeps health plugin sections parseable for legacy deep links", () => {
    expect(parseLifeOpsRoute("#lifeops.section=sleep").section).toBe("sleep");
    expect(parseLifeOpsRoute("#lifeops.section=screen-time").section).toBe(
      "screen-time",
    );
  });
});
