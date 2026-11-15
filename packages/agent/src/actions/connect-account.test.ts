import { afterEach, describe, expect, it, vi } from "vitest";
import { connectAccountAction } from "./connect-account.ts";

function message(text: string) {
  return { content: { text } } as never;
}

describe("CONNECT_ACCOUNT", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is owner-only", () => {
    expect(connectAccountAction.roleGate).toEqual({ minRole: "OWNER" });
  });

  it("offers sign-in when no host policy is set", async () => {
    vi.stubEnv("ELIZA_HOST_OPERATION_POLICY", "");
    await expect(
      connectAccountAction.validate(
        {} as never,
        message("add another claude account"),
      ),
    ).resolves.toBe(true);
  });

  it("is not offered when the host manages inference", async () => {
    vi.stubEnv("ELIZA_HOST_OPERATION_POLICY", "product");
    await expect(
      connectAccountAction.validate(
        {} as never,
        message("add another claude account"),
      ),
    ).resolves.toBe(false);
  });
});
