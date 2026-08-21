/** Tests the capability catalog against actual Shared service combinations. */

import { describe, expect, test } from "bun:test";
import { findAgentCapability } from "@elizaos/shared";
import {
  buildSharedCapabilityCatalog,
  formatSharedCapabilityCatalogForPrompt,
  sharedCapabilityTransportForSource,
} from "./shared-capability-catalog.js";

describe("Shared capability catalog", () => {
  test("derives optional capability availability from injected services", () => {
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

  test("marks private integrations as personal-workspace capabilities", () => {
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

  test("gives the model detailed truthful setup and safety context", () => {
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

  test("projects only trusted channel-source categories", () => {
    expect(sharedCapabilityTransportForSource("gateway-discord")).toBe("discord");
    expect(sharedCapabilityTransportForSource("twilio-sms")).toBe("sms");
    expect(sharedCapabilityTransportForSource("twilio-voice")).toBe("voice");
    expect(sharedCapabilityTransportForSource("client-chat")).toBe("app");
    expect(sharedCapabilityTransportForSource("unrecognized")).toBe("api");
  });
});
