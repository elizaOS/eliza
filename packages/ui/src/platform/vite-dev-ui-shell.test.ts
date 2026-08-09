/** Verifies deterministic standalone Vite-shell detection without a live browser origin. */

import { describe, expect, it } from "vitest";
import { isViteDevUiShell } from "./vite-dev-ui-shell";

describe("isViteDevUiShell", () => {
  it("recognizes the configured standalone Vite UI port", () => {
    expect(isViteDevUiShell({ port: "2138" })).toBe(true);
  });

  it("rejects backend, production, and server-side locations", () => {
    expect(isViteDevUiShell({ port: "31337" })).toBe(false);
    expect(isViteDevUiShell({ port: "" })).toBe(false);
    expect(isViteDevUiShell()).toBe(false);
  });
});
