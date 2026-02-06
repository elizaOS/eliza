import { describe, expect, it } from "vitest";

import copilotProxyPlugin from "../src/index";

describe("Copilot Proxy plugin exports", () => {
  it("exports plugin metadata", () => {
    expect(copilotProxyPlugin.name).toBe("copilot-proxy");
    expect(copilotProxyPlugin.description).toContain("Copilot Proxy");
    expect(typeof copilotProxyPlugin.models).toBe("object");
    expect(Array.isArray(copilotProxyPlugin.tests)).toBe(true);
  });
});
