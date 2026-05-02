/**
 * Plugin smoke test — verifies the Contacts runtime plugin shape and metadata.
 *
 * Intentionally avoids importing the React UI or registering the overlay app
 * (those require a Capacitor environment). The plugin module only depends on
 * shared role helpers, `@elizaos/core`, and the capacitor-contacts TS shim.
 */

import { describe, expect, it } from "vitest";
import { appContactsPlugin } from "../src/plugin.ts";

describe("appContactsPlugin", () => {
  it("declares the canonical app name", () => {
    expect(appContactsPlugin.name).toBe("@elizaos/app-contacts");
  });

  it("exposes the LIST_CONTACTS action", () => {
    const names = (appContactsPlugin.actions ?? []).map((a) => a.name);
    expect(names).toContain("LIST_CONTACTS");
  });

  it("declares an optional limit parameter on LIST_CONTACTS", () => {
    const list = (appContactsPlugin.actions ?? []).find(
      (a) => a.name === "LIST_CONTACTS",
    );
    const limitParam = list?.parameters?.find((p) => p.name === "limit");
    expect(limitParam?.required).toBe(false);
  });
});
