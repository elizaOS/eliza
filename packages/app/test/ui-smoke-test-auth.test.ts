/**
 * Regression coverage for the browser storage authority paired by the shared
 * Playwright Steward-session helpers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureStoredStewardTokenScope,
  readStoredStewardToken,
} from "../../shared/src/steward-session-client/index.js";
import {
  seedStewardSession,
  setStewardSession,
} from "./ui-smoke/helpers/test-auth";

const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_TOKEN_SCOPE_KEY = "steward_session_token_scope";
const STEWARD_ACTIVE_SCOPE_KEY = "steward_session_active_scope";
const PRODUCTION_SCOPE = "eliza-cloud:production";

type BrowserStorageScript = (arg: Record<string, string>) => unknown;

function fakePage() {
  const addInitScript = vi.fn(
    async (script: BrowserStorageScript, arg: Record<string, string>) => {
      script(arg);
    },
  );
  const evaluate = vi.fn(
    async (script: BrowserStorageScript, arg: Record<string, string>) => {
      script(arg);
    },
  );

  return {
    addInitScript,
    evaluate,
    page: {
      addInitScript,
      evaluate,
    } as unknown as Parameters<typeof seedStewardSession>[0],
  };
}

describe("UI-smoke Steward session storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("pairs a preboot token with the production scope by default", async () => {
    const { addInitScript, evaluate, page } = fakePage();
    window.localStorage.setItem(
      STEWARD_ACTIVE_SCOPE_KEY,
      "eliza-cloud:staging",
    );

    await seedStewardSession(page, { token: "seeded-token" });

    expect(addInitScript).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("seeded-token");
    expect(window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY)).toBe(
      PRODUCTION_SCOPE,
    );
    expect(window.localStorage.getItem(STEWARD_ACTIVE_SCOPE_KEY)).toBe(
      "eliza-cloud:staging",
    );
  });

  it("pairs a post-load token with the production scope by default", async () => {
    const { addInitScript, evaluate, page } = fakePage();
    window.localStorage.setItem(
      STEWARD_ACTIVE_SCOPE_KEY,
      "origin:http://127.0.0.1:8787",
    );

    await setStewardSession(page, { token: "post-load-token" });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(addInitScript).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
      "post-load-token",
    );
    expect(window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY)).toBe(
      PRODUCTION_SCOPE,
    );
    expect(window.localStorage.getItem(STEWARD_ACTIVE_SCOPE_KEY)).toBe(
      "origin:http://127.0.0.1:8787",
    );
  });

  it("matches the canonical reader and quarantines a wrong scope", async () => {
    const { page } = fakePage();
    configureStoredStewardTokenScope("https://api.eliza.app/api/v1");

    await seedStewardSession(page, { token: "accepted-token" });
    expect(readStoredStewardToken()).toBe("accepted-token");

    await setStewardSession(page, {
      token: "wrong-scope-token",
      scope: "eliza-cloud:staging",
    });
    expect(readStoredStewardToken()).toBeNull();
    expect(window.localStorage.getItem(STEWARD_ACTIVE_SCOPE_KEY)).toBe(
      PRODUCTION_SCOPE,
    );
  });

  it("honors an explicit preboot scope without claiming the active target", async () => {
    const { page } = fakePage();
    const options = {
      token: "staging-token",
      scope: "eliza-cloud:staging",
    };

    await seedStewardSession(page, options);

    expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
      "staging-token",
    );
    expect(window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY)).toBe(
      "eliza-cloud:staging",
    );
    expect(window.localStorage.getItem(STEWARD_ACTIVE_SCOPE_KEY)).toBeNull();
  });

  it("honors an explicit post-load scope without claiming the active target", async () => {
    const { page } = fakePage();
    const options = {
      token: "self-hosted-token",
      scope: "origin:https://cloud.example.test",
    };

    await setStewardSession(page, options);

    expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
      "self-hosted-token",
    );
    expect(window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY)).toBe(
      "origin:https://cloud.example.test",
    );
    expect(window.localStorage.getItem(STEWARD_ACTIVE_SCOPE_KEY)).toBeNull();
  });
});
