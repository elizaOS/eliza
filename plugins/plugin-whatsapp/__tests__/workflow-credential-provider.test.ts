/**
 * Confirms WhatsAppWorkflowCredentialProvider resolves whatsAppApi credentials
 * (trimmed access token + phone number ID) for the workflow plugin and reports
 * missing config correctly. Fake runtime with stubbed getSetting; no network.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppWorkflowCredentialProvider } from "../src/workflow-credential-provider";

function makeRuntime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    getSetting: vi.fn((key: string) => settings[key]),
  } as never as IAgentRuntime;
}

describe("WhatsApp workflow credential provider", () => {
  it("returns trimmed WhatsApp API credentials for workflow usage", async () => {
    const provider = new WhatsAppWorkflowCredentialProvider(
      makeRuntime({
        WHATSAPP_ACCESS_TOKEN: " token ",
        WHATSAPP_PHONE_NUMBER_ID: " phone-id ",
      })
    );

    await expect(provider.resolve("user-1", "whatsAppApi")).resolves.toEqual({
      status: "credential_data",
      data: { accessToken: "token", phoneNumberId: "phone-id" },
    });
  });

  it("does not expose partial or unsupported credentials", async () => {
    const provider = new WhatsAppWorkflowCredentialProvider(
      makeRuntime({ WHATSAPP_ACCESS_TOKEN: "token" })
    );

    await expect(provider.resolve("user-1", "whatsAppApi")).resolves.toBeNull();
    await expect(provider.resolve("user-1", "other")).resolves.toBeNull();
    expect(provider.checkCredentialTypes(["whatsAppApi", "other"])).toEqual({
      supported: ["whatsAppApi"],
      unsupported: ["other"],
    });
  });
});
