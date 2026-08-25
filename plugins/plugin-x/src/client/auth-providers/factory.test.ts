import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting } from "../../utils/settings";
import { BrokerAuthProvider } from "./broker";
import { EnvAuthProvider } from "./env";
import { createTwitterAuthProvider, getTwitterAuthMode } from "./factory";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";

describe("twitter auth provider factory", () => {
  beforeEach(() => {
    getSetting.mockReset();
    getSetting.mockReturnValue(undefined);
  });

  it("defaults to env mode when nothing is configured", () => {
    expect(getTwitterAuthMode()).toBe("env");
  });

  it("falls back to the runtime setting when state has no mode", () => {
    getSetting.mockReturnValue("oauth");
    expect(getTwitterAuthMode({} as never)).toBe("oauth");
  });

  it("lets the client state override the runtime setting", () => {
    getSetting.mockReturnValue("env");
    expect(
      getTwitterAuthMode({} as never, { TWITTER_AUTH_MODE: "broker" } as never),
    ).toBe("broker");
  });

  it("normalizes mode case-insensitively", () => {
    expect(
      getTwitterAuthMode(undefined, { TWITTER_AUTH_MODE: "OAUTH" } as never),
    ).toBe("oauth");
  });

  it("fails closed on an invalid mode instead of silently defaulting", () => {
    expect(() =>
      getTwitterAuthMode(undefined, { TWITTER_AUTH_MODE: "magic" } as never),
    ).toThrow(/Invalid TWITTER_AUTH_MODE/);
  });

  it("fails closed on an empty-string mode from serialized state", () => {
    expect(() =>
      getTwitterAuthMode(undefined, { TWITTER_AUTH_MODE: "" } as never),
    ).toThrow(/Invalid TWITTER_AUTH_MODE/);
  });

  it("builds the provider matching each supported mode", () => {
    expect(
      createTwitterAuthProvider(
        {} as never,
        { TWITTER_AUTH_MODE: "env" } as never,
      ),
    ).toBeInstanceOf(EnvAuthProvider);
    expect(
      createTwitterAuthProvider(
        {} as never,
        { TWITTER_AUTH_MODE: "oauth" } as never,
      ),
    ).toBeInstanceOf(OAuth2PKCEAuthProvider);
    expect(
      createTwitterAuthProvider(
        {} as never,
        { TWITTER_AUTH_MODE: "broker" } as never,
      ),
    ).toBeInstanceOf(BrokerAuthProvider);
  });
});
