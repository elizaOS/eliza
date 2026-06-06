import {
  STEWARD_NONCE_EXCHANGE_ENDPOINT,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
} from "@elizaos/shared/steward-session-client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeStewardCodeFromQuery,
  resolveStewardAuthEndpoint,
} from "./steward-session";

describe("resolveStewardAuthEndpoint", () => {
  it("routes prod browser hosts to api.elizacloud.ai", () => {
    expect(
      resolveStewardAuthEndpoint(
        STEWARD_NONCE_EXCHANGE_ENDPOINT,
        "www.elizacloud.ai",
      ),
    ).toBe("https://api.elizacloud.ai/api/auth/steward-nonce-exchange");
    expect(
      resolveStewardAuthEndpoint(STEWARD_SESSION_ENDPOINT, "elizacloud.ai"),
    ).toBe("https://api.elizacloud.ai/api/auth/steward-session");
    expect(
      resolveStewardAuthEndpoint(STEWARD_REFRESH_ENDPOINT, "dev.elizacloud.ai"),
    ).toBe("https://api.elizacloud.ai/api/auth/steward-refresh");
  });

  it("routes staging.elizacloud.ai to api-staging (tenant isolation)", () => {
    // Staging Steward tenant is `elizacloud-staging`; the prod Worker pins
    // tenant `elizacloud`. Mixing them previously caused the bypass route to
    // 401 `code_invalid` and silently send the user back to /login on every
    // magic-link return.
    expect(
      resolveStewardAuthEndpoint(
        STEWARD_NONCE_EXCHANGE_ENDPOINT,
        "staging.elizacloud.ai",
      ),
    ).toBe(
      "https://api-staging.elizacloud.ai/api/auth/steward-nonce-exchange",
    );
    expect(
      resolveStewardAuthEndpoint(
        STEWARD_SESSION_ENDPOINT,
        "staging.elizacloud.ai",
      ),
    ).toBe("https://api-staging.elizacloud.ai/api/auth/steward-session");
    expect(
      resolveStewardAuthEndpoint(
        STEWARD_REFRESH_ENDPOINT,
        "staging.elizacloud.ai",
      ),
    ).toBe("https://api-staging.elizacloud.ai/api/auth/steward-refresh");
  });

  it("keeps local and preview auth calls same-origin", () => {
    expect(
      resolveStewardAuthEndpoint(STEWARD_NONCE_EXCHANGE_ENDPOINT, "localhost"),
    ).toBe(STEWARD_NONCE_EXCHANGE_ENDPOINT);
    expect(
      resolveStewardAuthEndpoint(
        STEWARD_NONCE_EXCHANGE_ENDPOINT,
        "preview.pages.dev",
      ),
    ).toBe(STEWARD_NONCE_EXCHANGE_ENDPOINT);
  });
});

describe("consumeStewardCodeFromQuery", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/login");
    delete (window as Window & { __stewardOAuthHash?: string })
      .__stewardOAuthHash;
  });

  it("consumes code from the query string", () => {
    window.history.replaceState(null, "", "/login?code=query-code&state=ok");

    expect(consumeStewardCodeFromQuery()).toBe("query-code");
    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe("?state=ok");
  });

  it("consumes code from a live hash fragment", () => {
    window.history.replaceState(null, "", "/login#code=hash-code&state=ok");

    expect(consumeStewardCodeFromQuery()).toBe("hash-code");
    expect(window.location.pathname).toBe("/login");
    expect(window.location.hash).toBe("#state=ok");
  });

  it("consumes code from the pre-init hash snapshot", () => {
    (
      window as Window & {
        __stewardOAuthHash?: string;
      }
    ).__stewardOAuthHash = "#code=snapshotted-code";
    window.history.replaceState(null, "", "/login");

    expect(consumeStewardCodeFromQuery()).toBe("snapshotted-code");
    expect(
      (window as Window & { __stewardOAuthHash?: string }).__stewardOAuthHash,
    ).toBeUndefined();
  });
});
