import { describe, expect, it } from "vitest";
import { lifeOpsProviderDescription } from "./lifeops.js";

describe("lifeops provider routing text", () => {
  it("names only the owner surfaces the host registers", () => {
    const text = lifeOpsProviderDescription(new Set(["alarms", "reminders"]));
    expect(text).not.toContain("OWNER_ALARMS");
    expect(text).not.toContain("OWNER_REMINDERS");
    expect(text).toContain("Route todos to OWNER_TODOS, habits/routines");
  });

  it("keeps every owner route without the setting", () => {
    expect(lifeOpsProviderDescription(new Set())).toContain(
      "Route todos to OWNER_TODOS, reminders to OWNER_REMINDERS, alarms to the device Clock proposal (PROPOSE_DEVICE_ACTION) when the turn offers clock handoff, otherwise OWNER_ALARMS (an in-app reminder that does not ring), habits/routines to OWNER_ROUTINES,",
    );
  });
});
