/**
 * Smoke test — verifies the plugin metadata wires the intended actions,
 * service, route, and auto-enable env keys. This protects against silent
 * drift when actions are renamed or dropped.
 */

import { describe, expect, it } from "vitest";
import calendlyPlugin, { CalendlyService } from "../index.js";
import { CalendlyActions } from "../types.js";

describe("calendlyPlugin", () => {
  it("exposes the expected actions, service, webhook route, and autoEnable config", () => {
    expect(calendlyPlugin.name).toBe("calendly");
    expect(calendlyPlugin.services).toContain(CalendlyService);

    const actionNames = (calendlyPlugin.actions ?? [])
      .map((a) => a.name)
      .sort();
    expect(actionNames).toEqual(
      [
        CalendlyActions.BOOK_CALENDLY_SLOT,
        CalendlyActions.CANCEL_CALENDLY_BOOKING,
        CalendlyActions.LIST_CALENDLY_EVENT_TYPES,
      ].sort(),
    );

    const routes = calendlyPlugin.routes ?? [];
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/calendly/webhook");
    expect(routes[0].type).toBe("POST");

    expect(calendlyPlugin.autoEnable?.envKeys).toEqual([
      "CALENDLY_ACCESS_TOKEN",
      "MILADY_E2E_CALENDLY_ACCESS_TOKEN",
    ]);
  });
});
