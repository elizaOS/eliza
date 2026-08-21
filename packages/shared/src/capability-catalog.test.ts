/** Unit tests for the runtime-neutral capability catalog projection. */

import { describe, expect, it } from "vitest";
import {
  type AgentCapabilityCatalog,
  findAgentCapability,
  formatAgentCapabilityCatalog,
} from "./capability-catalog.js";

const catalog: AgentCapabilityCatalog = {
  version: 1,
  tier: "shared",
  transport: "web",
  capabilities: [
    {
      id: "web-search",
      label: "Public web research",
      examples: ["Find current information"],
      availability: "available",
      currentTier: "shared",
      requiredTier: "shared",
      transports: ["web"],
      prerequisites: [],
      consequence: "read_only",
      requiresConfirmation: false,
      nextAction: "none",
    },
    {
      id: "calendar",
      label: "Calendar",
      examples: ["Check tomorrow"],
      availability: "needs_workspace",
      currentTier: "shared",
      requiredTier: "personal",
      transports: ["web"],
      prerequisites: [
        { kind: "workspace", id: "personal", label: "Personal workspace" },
      ],
      consequence: "consequential",
      requiresConfirmation: true,
      nextAction: "upgrade_workspace",
    },
  ],
};

describe("capability catalog", () => {
  it("finds structured capability state", () => {
    expect(findAgentCapability(catalog, "calendar")).toMatchObject({
      availability: "needs_workspace",
      requiredTier: "personal",
    });
  });

  it("projects only concise availability context", () => {
    const text = formatAgentCapabilityCatalog(catalog);
    expect(text).toContain("Available now: Public web research.");
    expect(text).toContain("Calendar (needs workspace)");
    expect(text).not.toContain("Check tomorrow");
  });
});
