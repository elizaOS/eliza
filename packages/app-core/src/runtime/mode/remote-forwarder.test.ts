import { describe, expect, test } from "vitest";
import { shouldForwardToRemoteTarget } from "./remote-forwarder";

describe("shouldForwardToRemoteTarget", () => {
  test("forwards POST /api/cloud/login", () => {
    expect(shouldForwardToRemoteTarget("/api/cloud/login", "POST")).toBe(true);
  });

  test("forwards POST /api/cloud/disconnect", () => {
    expect(shouldForwardToRemoteTarget("/api/cloud/disconnect", "POST")).toBe(
      true,
    );
  });

  test("forwards mutations under /api/cloud/billing/", () => {
    expect(
      shouldForwardToRemoteTarget("/api/cloud/billing/portal", "POST"),
    ).toBe(true);
    expect(
      shouldForwardToRemoteTarget("/api/cloud/billing/portal", "GET"),
    ).toBe(false);
  });

  test("forwards mutations under /api/cloud/v1/", () => {
    expect(shouldForwardToRemoteTarget("/api/cloud/v1/agents", "POST")).toBe(
      true,
    );
    expect(shouldForwardToRemoteTarget("/api/cloud/v1/agents", "DELETE")).toBe(
      true,
    );
  });

  test("does not forward GET requests", () => {
    expect(shouldForwardToRemoteTarget("/api/cloud/login", "GET")).toBe(false);
  });

  test("does not forward unrelated paths", () => {
    expect(shouldForwardToRemoteTarget("/api/agent/reset", "POST")).toBe(
      false,
    );
  });
});
