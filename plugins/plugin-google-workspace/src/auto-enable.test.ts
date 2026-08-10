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

  it("keeps personal Google setup visible when a Chat account is disabled", () => {
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
    ).toBe(true);
  });

  it("keeps personal Google setup visible when Google Chat is disabled", () => {
    expect(
      shouldEnable(
        ctx({
          config: { connectors: { googlechat: { enabled: false } } },
        })
      )
    ).toBe(true);
  });

  it("keeps personal Google setup visible for an empty Chat configuration", () => {
    expect(
      shouldEnable(
        ctx({
          config: { connectors: { googlechat: {} } },
        })
      )
    ).toBe(true);
  });

  it("exposes personal Google independently of the Calendar plugin", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            plugins: { entries: { calendar: { enabled: true } } },
          },
        })
      )
    ).toBe(true);
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

  it("does not inspect legacy OAuth environment configuration", () => {
    expect(
      shouldEnable(
        ctx({
          env: {
            GOOGLE_CLIENT_ID: "client",
          } as NodeJS.ProcessEnv,
        })
      )
    ).toBe(true);
  });

  it("exposes setup without legacy OAuth environment configuration", () => {
    expect(shouldEnable(ctx({}))).toBe(true);
  });

  it("exposes personal Google setup with empty config and no OAuth env", () => {
    expect(shouldEnable(ctx({}))).toBe(true);
  });

  it("honors entries google-workspace enabled=false over googlechat", () => {
    expect(
      shouldEnable(
        ctx({
          config: {
            connectors: { googlechat: { serviceAccountKey: "{}" } },
            plugins: {
              entries: { "google-workspace": { enabled: false } },
            },
          },
        })
      )
    ).toBe(false);
  });
});
