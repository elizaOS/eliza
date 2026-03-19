import { describe, expect, it } from "vitest";
import { parseShellRoute } from "./shell-params";

describe("parseShellRoute", () => {
  it("keeps the default app shell when no shell query is present", () => {
    expect(parseShellRoute("")).toEqual({ mode: "main" });
  });

  it("detects the settings shell", () => {
    expect(parseShellRoute("?shell=settings")).toEqual({ mode: "settings" });
  });

  it("preserves settings tab hints for dedicated settings windows", () => {
    expect(parseShellRoute("?shell=settings&tab=cloud")).toEqual({
      mode: "settings",
      tab: "cloud",
    });
  });

  it("detects detached surface shells for supported tabs", () => {
    expect(parseShellRoute("?shell=surface&tab=chat")).toEqual({
      mode: "surface",
      tab: "chat",
    });
    expect(parseShellRoute("?shell=surface&tab=triggers")).toEqual({
      mode: "surface",
      tab: "triggers",
    });
    expect(parseShellRoute("?shell=surface&tab=plugins")).toEqual({
      mode: "surface",
      tab: "plugins",
    });
    expect(parseShellRoute("?shell=surface&tab=connectors")).toEqual({
      mode: "surface",
      tab: "connectors",
    });
    expect(parseShellRoute("?shell=surface&tab=cloud")).toEqual({
      mode: "surface",
      tab: "cloud",
    });
  });

  it("falls back to the main shell for unsupported detached tabs", () => {
    expect(parseShellRoute("?shell=surface&tab=settings")).toEqual({
      mode: "main",
    });
  });
});
