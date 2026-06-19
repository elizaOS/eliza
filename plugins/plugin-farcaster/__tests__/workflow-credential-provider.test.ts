import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { FarcasterWorkflowCredentialProvider } from "../workflow-credential-provider";

function provider(getSetting: IAgentRuntime["getSetting"]) {
  return new FarcasterWorkflowCredentialProvider({
    getSetting,
  } as IAgentRuntime);
}

describe("FarcasterWorkflowCredentialProvider", () => {
  it("returns a trimmed Neynar API key for HTTP header auth", async () => {
    const subject = provider(vi.fn(() => "  neynar-key  "));

    await expect(subject.resolve("user", "httpHeaderAuth")).resolves.toEqual({
      status: "credential_data",
      data: { name: "api_key", value: "neynar-key" },
    });
  });

  it("returns null for unsupported, missing, blank, or throwing credential sources", async () => {
    await expect(provider(vi.fn(() => "key")).resolve("user", "apiKey")).resolves.toBeNull();
    await expect(provider(vi.fn(() => " ")).resolve("user", "httpHeaderAuth")).resolves.toBeNull();
    await expect(
      provider(
        vi.fn(() => {
          throw new Error("settings unavailable");
        })
      ).resolve("user", "httpHeaderAuth")
    ).resolves.toBeNull();
  });

  it("reports supported and unsupported credential types", () => {
    const subject = provider(vi.fn());

    expect(subject.checkCredentialTypes(["httpHeaderAuth", "oauth2"])).toEqual({
      supported: ["httpHeaderAuth"],
      unsupported: ["oauth2"],
    });
  });
});
