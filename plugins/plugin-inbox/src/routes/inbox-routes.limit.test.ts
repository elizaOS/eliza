/**
 * Prefix-coerced inbox triage limit must be invalid.
 * Number("1e2") === 100 used to become a real page size.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../actions/inbox.ts", () => ({
  executeInboxQueueOperation: vi.fn(),
}));

vi.mock("../inbox/service.ts", () => ({
  InboxService: class {
    constructor() {
      throw new Error("InboxService should not be constructed");
    }
  },
}));

describe("inbox triage query integers", () => {
  it("1e2 is invalid instead of becoming 100", async () => {
    const { queryInt } = await import("./inbox-routes.ts");
    expect(queryInt("1e2", 50)).toBe("invalid");
  });

  it("007 is invalid instead of becoming 7", async () => {
    const { queryInt } = await import("./inbox-routes.ts");
    expect(queryInt("007", 50)).toBe("invalid");
  });

  it("0x10 is invalid instead of becoming 16", async () => {
    const { queryInt } = await import("./inbox-routes.ts");
    expect(queryInt("0x10", 50)).toBe("invalid");
  });

  it("canonical 3 still parses", async () => {
    const { queryInt } = await import("./inbox-routes.ts");
    expect(queryInt("3", 50)).toBe(3);
  });

  it("omitted limit keeps the fallback", async () => {
    const { queryInt } = await import("./inbox-routes.ts");
    expect(queryInt(undefined, 50)).toBe(50);
  });
});
