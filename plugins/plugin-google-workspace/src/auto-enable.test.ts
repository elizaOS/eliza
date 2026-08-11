/**
 * Auto-enable predicates for plugin-google-workspace.
 * Deterministic: pure shouldEnable checks over synthetic config/env.
 */
import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable.ts";

function ctx(partial: { config?: Record<string, unknown>; env?: NodeJS.ProcessEnv }) {
  return {
    config: partial.config ?? {},
    env: partial.env ?? {},
    isNativePlatform: false,
  };
}

describe("plugin-google-workspace shouldEnable", () => {
  it("enables for a googlechat connector block that is not disabled", () => {
    expect(
      shouldEnable(
        ctx({
          config: { connectors: { googlechat: { serviceAccountKey: "{}" } } },
        })
      )
    ).toBe(true);
  });

  it("enables for an object-form serviceAccount (parsed key JSON)", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            connectors: {
              googlechat: {
                serviceAccount: { client_email: "bot@example.iam", private_key: "k" },
              },
            },
          },
        })
      )
    ).toBe(true);
  });

  it("enables for a serviceAccountFile path", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            connectors: { googlechat: { serviceAccountFile: "/keys/chat.json" } },
          },
        })
      )
    ).toBe(true);
  });

  it("enables for a record-form accounts map with a credentialed account", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            connectors: {
              googlechat: {
                accounts: {
                  main: { serviceAccountFile: "/keys/main.json" },
                },
              },
            },
          },
        })
      )
    ).toBe(true);
  });

  it("skips accounts rows with enabled=false when detecting credentials", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            connectors: {
              googlechat: {
                accounts: {
                  off: { enabled: false, serviceAccount: "{}" },
                },
              },
            },
          },
        })
      )
    ).toBe(false);
  });

  it("does not enable when googlechat is explicitly disabled", () => {
    expect(
      shouldEnable(
        ctx({
          config: { connectors: { googlechat: { enabled: false } } },
        })
      )
    ).toBe(false);
  });

  it("does not enable for an empty googlechat object", () => {
    expect(
      shouldEnable(
        ctx({
          config: { connectors: { googlechat: {} } },
        })
      )
    ).toBe(false);
  });

  it("does not enable merely because calendar is enabled (Apple/Microsoft/ICS)", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            plugins: { entries: { calendar: { enabled: true } } },
          },
        })
      )
    ).toBe(false);
  });

  it("enables when plugins.entries.google-workspace is explicitly enabled", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            plugins: { entries: { "google-workspace": { enabled: true } } },
          },
        })
      )
    ).toBe(true);
  });

  it("enables when the full GOOGLE_CLIENT_* + REDIRECT_URI trio is set", () => {
    expect(
      shouldEnable(
        ctx({
          env: {
            GOOGLE_CLIENT_ID: "client",
            GOOGLE_CLIENT_SECRET: "secret",
            GOOGLE_REDIRECT_URI: "https://example.com/oauth/callback",
          } as NodeJS.ProcessEnv,
        })
      )
    ).toBe(true);
  });

  it("does not enable when redirect URI is missing from the OAuth trio", () => {
    expect(
      shouldEnable(
        ctx({
          env: {
            GOOGLE_CLIENT_ID: "client",
            GOOGLE_CLIENT_SECRET: "secret",
          } as NodeJS.ProcessEnv,
        })
      )
    ).toBe(false);
  });

  it("stays off with empty config and no OAuth env", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
  });

  it("honors entries google-workspace enabled=false over OAuth env and googlechat", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            connectors: { googlechat: { serviceAccountKey: "{}" } },
            plugins: {
              entries: { "google-workspace": { enabled: false } },
            },
          },
          env: {
            GOOGLE_CLIENT_ID: "client",
            GOOGLE_CLIENT_SECRET: "secret",
            GOOGLE_REDIRECT_URI: "https://example.com/oauth/callback",
          } as NodeJS.ProcessEnv,
        })
      )
    ).toBe(false);
  });
});
