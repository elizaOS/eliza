/** Tests the capability catalog against actual Shared service combinations. */

import { findAgentCapability } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  buildSharedCapabilityCatalog,
  formatSharedCapabilityCatalogForPrompt,
} from "./shared-capability-catalog.js";

describe("Shared capability catalog", () => {
  it("derives optional capability availability from injected services", () => {
    const catalog = buildSharedCapabilityCatalog({
      webSearch: true,
      reminders: true,
      todos: false,
      media: false,
      transport: "sms",
    });
    expect(findAgentCapability(catalog, "reminders")?.availability).toBe("available");
    expect(findAgentCapability(catalog, "todos")?.availability).toBe("unavailable");
    expect(findAgentCapability(catalog, "reminders")?.transports).toEqual(["sms"]);
  });

  it("marks private integrations as personal-workspace capabilities", () => {
    const catalog = buildSharedCapabilityCatalog({
      webSearch: true,
      reminders: false,
      todos: false,
      media: false,
    });
    expect(findAgentCapability(catalog, "calendar")).toMatchObject({
      availability: "needs_workspace",
      requiredTier: "personal",
      nextAction: "upgrade_workspace",
      requiresConfirmation: true,
    });
  });

  it("gives the model detailed truthful setup and safety context", () => {
    const catalog = buildSharedCapabilityCatalog({
      webSearch: true,
      reminders: false,
      todos: false,
      media: false,
      transport: "web",
    });

    const text = formatSharedCapabilityCatalogForPrompt(catalog);
    expect(text).toContain("Capability tier: shared. Transport: web.");
    expect(text).toContain("Calendar (calendar)");
    expect(text).toContain("examples: Check tomorrow; Schedule a meeting");
    expect(text).toContain("prerequisites: Personal workspace, Connect calendar");
    expect(text).toContain("consequence: consequential");
    expect(text).toContain("confirmation: required before effect");
    expect(text).toContain("next: upgrade workspace");
    expect(text).toContain("Public web research (web-search); availability: available");
  });
});
