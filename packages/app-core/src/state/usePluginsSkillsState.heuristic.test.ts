import { describe, expect, it } from "vitest";
import type { PluginParamDef } from "../api/client-types-config";
import { pickPrimaryCredentialParam } from "./usePluginsSkillsState";

function param(
  key: string,
  sensitive: boolean,
  overrides: Partial<PluginParamDef> = {},
): PluginParamDef {
  return {
    key,
    type: "string",
    description: `${key} (test fixture)`,
    required: false,
    sensitive,
    default: undefined,
    options: undefined,
    currentValue: null,
    isSet: false,
    ...overrides,
  };
}

describe("pickPrimaryCredentialParam", () => {
  it("picks the *_API_KEY field over a non-sensitive model slug field", () => {
    const params: PluginParamDef[] = [
      param("OPENROUTER_LARGE_MODEL", false),
      param("OPENROUTER_API_KEY", true),
    ];
    expect(pickPrimaryCredentialParam(params)?.key).toBe(
      "OPENROUTER_API_KEY",
    );
  });

  it("picks *_BOT_TOKEN when it is the only sensitive param", () => {
    const params: PluginParamDef[] = [
      param("DISCORD_APPLICATION_ID", false),
      param("DISCORD_BOT_TOKEN", true),
    ];
    expect(pickPrimaryCredentialParam(params)?.key).toBe(
      "DISCORD_BOT_TOKEN",
    );
  });

  it("prefers *_API_TOKEN over *_WEBHOOK_SECRET when both are sensitive", () => {
    const params: PluginParamDef[] = [
      param("GITHUB_WEBHOOK_SECRET", true),
      param("GITHUB_API_TOKEN", true),
    ];
    expect(pickPrimaryCredentialParam(params)?.key).toBe("GITHUB_API_TOKEN");
  });

  it("prefers *_API_TOKEN over *_PRIVATE_KEY (priority order matters)", () => {
    const params: PluginParamDef[] = [
      param("GITHUB_APP_PRIVATE_KEY", true),
      param("GITHUB_API_TOKEN", true),
    ];
    expect(pickPrimaryCredentialParam(params)?.key).toBe("GITHUB_API_TOKEN");
  });

  it("picks *_PRIVATE_KEY when it is the only sensitive param (wallet)", () => {
    const params: PluginParamDef[] = [
      param("EVM_RPC_URL", false),
      param("EVM_PRIVATE_KEY", true),
    ];
    expect(pickPrimaryCredentialParam(params)?.key).toBe("EVM_PRIVATE_KEY");
  });

  it("picks *_SECRET_KEY when it is the only sensitive param (wallet)", () => {
    const params: PluginParamDef[] = [
      param("WALLET_NETWORK", false),
      param("WALLET_SECRET_KEY", true),
    ];
    expect(pickPrimaryCredentialParam(params)?.key).toBe("WALLET_SECRET_KEY");
  });

  it("falls back to the first sensitive param when none match priority patterns (explicit contract)", () => {
    const params: PluginParamDef[] = [
      param("CUSTOM_THING_FIRST", true),
      param("CUSTOM_THING_SECOND", true),
    ];
    // No regex in the priority list matches either key. Documented contract:
    // fall back to the first sensitive parameter in declared order.
    expect(pickPrimaryCredentialParam(params)?.key).toBe("CUSTOM_THING_FIRST");
  });

  it("returns undefined when there are no sensitive params", () => {
    const params: PluginParamDef[] = [
      param("PUBLIC_BASE_URL", false),
      param("LARGE_MODEL", false),
    ];
    expect(pickPrimaryCredentialParam(params)).toBeUndefined();
  });

  it("returns undefined when the parameters array is empty", () => {
    expect(pickPrimaryCredentialParam([])).toBeUndefined();
  });
});
