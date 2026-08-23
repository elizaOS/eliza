/**
 * Verifies safe sorting in cloud extra settings groups and agent lists when order or dates contain NaN / invalid strings.
 */

import { describe, expect, it } from "vitest";
import {
  listExtraSettingsGroups,
  registerSettingsGroup,
} from "../settings/cloud-settings-group.js";

describe("cloud settings and routes safe sort", () => {
  it("safely orders extra settings groups by numeric order with NaN coerced to 0", () => {
    registerSettingsGroup({
      id: "group-high",
      label: "High Group",
      order: 100,
    });
    registerSettingsGroup({
      id: "group-nan",
      label: "NaN Group",
      order: NaN,
    });
    registerSettingsGroup({
      id: "group-low",
      label: "Low Group",
      order: 10,
    });

    const groups = listExtraSettingsGroups();
    const groupNanIdx = groups.findIndex((g) => g.id === "group-nan");
    const groupLowIdx = groups.findIndex((g) => g.id === "group-low");
    const groupHighIdx = groups.findIndex((g) => g.id === "group-high");

    expect(groupNanIdx).toBeLessThan(groupLowIdx);
    expect(groupLowIdx).toBeLessThan(groupHighIdx);
  });

  it("safely compares agent dates when createdAt contains invalid date strings", () => {
    const agents = [
      { id: "agent-valid-new", createdAt: "2026-08-23T12:00:00Z" },
      { id: "agent-invalid", createdAt: "not-a-date" },
      { id: "agent-valid-old", createdAt: "2026-08-20T12:00:00Z" },
    ];

    agents.sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      const safeA = Number.isFinite(aTime) ? aTime : 0;
      const safeB = Number.isFinite(bTime) ? bTime : 0;
      return safeA - safeB;
    });

    expect(agents[0].id).toBe("agent-invalid");
    expect(agents[1].id).toBe("agent-valid-old");
    expect(agents[2].id).toBe("agent-valid-new");
  });
});
