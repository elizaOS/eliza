/**
 * Unit tests for the forced host-mode deploy guard: production-mode builds must
 * refuse to bake VITE_FORCE_APP_MODE / VITE_FORCE_APEX_CONSOLE, the flags that
 * override the app-mode and apex hostname checks for every host.
 */
import { describe, expect, it } from "vitest";
import { forbiddenForcedHostModeFlags } from "./forced-host-mode-guard.mjs";

describe("forbiddenForcedHostModeFlags", () => {
  it("passes a clean deploy env", () => {
    expect(forbiddenForcedHostModeFlags({})).toEqual([]);
    expect(
      forbiddenForcedHostModeFlags({ VITE_ENVIRONMENT: "production" }),
    ).toEqual([]);
  });

  it("flags VITE_FORCE_APP_MODE when set", () => {
    expect(
      forbiddenForcedHostModeFlags({ VITE_FORCE_APP_MODE: "true" }),
    ).toEqual(["VITE_FORCE_APP_MODE"]);
  });

  it("flags VITE_FORCE_APEX_CONSOLE when set", () => {
    expect(
      forbiddenForcedHostModeFlags({ VITE_FORCE_APEX_CONSOLE: "true" }),
    ).toEqual(["VITE_FORCE_APEX_CONSOLE"]);
  });

  it("flags ANY non-blank value — deploy config must not contain the var at all", () => {
    expect(
      forbiddenForcedHostModeFlags({ VITE_FORCE_APP_MODE: "false" }),
    ).toEqual(["VITE_FORCE_APP_MODE"]);
  });

  it("treats unset and blank values as absent", () => {
    expect(
      forbiddenForcedHostModeFlags({
        VITE_FORCE_APP_MODE: "",
        VITE_FORCE_APEX_CONSOLE: "   ",
      }),
    ).toEqual([]);
  });

  it("reports both flags when both are set", () => {
    expect(
      forbiddenForcedHostModeFlags({
        VITE_FORCE_APP_MODE: "true",
        VITE_FORCE_APEX_CONSOLE: "true",
      }),
    ).toEqual(["VITE_FORCE_APP_MODE", "VITE_FORCE_APEX_CONSOLE"]);
  });
});
