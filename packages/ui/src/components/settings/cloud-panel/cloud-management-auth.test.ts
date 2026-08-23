/** Verifies the credential precedence used by native Cloud settings. */
// @vitest-environment jsdom

import {
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/shared")>()),
  getElizaApiToken: () => null,
}));

vi.mock("../../../config/boot-config", () => ({
  getBootConfig: () => ({}),
}));

import {
  resolveCloudManagementToken,
  useHasCloudManagementCredential,
} from "./cloud-management-auth";

describe("resolveCloudManagementToken", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("prefers the independently scoped Steward session", () => {
    expect(
      resolveCloudManagementToken({
        stewardToken: " steward-jwt ",
        bootApiToken: "eliza_boot-owner-key",
        runtimeApiToken: "eliza_runtime-owner-key",
      }),
    ).toBe("steward-jwt");
  });

  it("accepts the owner API key returned by desktop device-code login", () => {
    expect(
      resolveCloudManagementToken({
        stewardToken: null,
        bootApiToken: "eliza_boot-owner-key",
        runtimeApiToken: null,
      }),
    ).toBe("eliza_boot-owner-key");
  });

  it("rejects unrelated agent bearer strings", () => {
    expect(
      resolveCloudManagementToken({
        stewardToken: null,
        bootApiToken: "container-bearer",
        runtimeApiToken: "not-an-owner-key",
      }),
    ).toBe("");
  });

  it("reacts to same-document and cross-document Steward token removal", () => {
    const { result } = renderHook(() => useHasCloudManagementCredential());
    expect(result.current).toBe(false);

    act(() => {
      localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
      window.dispatchEvent(new CustomEvent(STEWARD_SESSION_CHANGE_EVENT));
    });
    expect(result.current).toBe(true);

    act(() => {
      localStorage.removeItem(STEWARD_TOKEN_KEY);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STEWARD_TOKEN_KEY,
          oldValue: "steward-token",
          newValue: null,
        }),
      );
    });
    expect(result.current).toBe(false);
  });
});
