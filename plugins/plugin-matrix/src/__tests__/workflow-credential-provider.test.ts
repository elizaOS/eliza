/**
 * Unit tests for `MatrixWorkflowCredentialProvider`: asserts it yields Matrix
 * credentials only when both access token and homeserver are set, against an
 * in-memory `getSetting` stub.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MatrixWorkflowCredentialProvider } from "../workflow-credential-provider.js";

function runtimeWithSettings(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("Matrix workflow credential provider", () => {
  it("returns trimmed Matrix credentials only when access token and homeserver are present", async () => {
    const provider = await MatrixWorkflowCredentialProvider.start(
      runtimeWithSettings({
        MATRIX_ACCESS_TOKEN: " token ",
        MATRIX_HOMESERVER: " https://matrix.example ",
      })
    );

    await expect(provider.resolve("user", "matrixApi")).resolves.toEqual({
      status: "credential_data",
      data: { accessToken: "token", homeserverUrl: "https://matrix.example" },
    });
  });

  it("does not claim unsupported or unauthenticated credential requests", async () => {
    const provider = await MatrixWorkflowCredentialProvider.start(
      runtimeWithSettings({
        MATRIX_ACCESS_TOKEN: " ",
        MATRIX_HOMESERVER: "https://matrix.example",
      })
    );

    await expect(provider.resolve("user", "matrixApi")).resolves.toBeNull();
    await expect(provider.resolve("user", "slackApi")).resolves.toBeNull();
    expect(provider.checkCredentialTypes(["matrixApi", "slackApi"])).toEqual({
      supported: ["matrixApi"],
      unsupported: ["slackApi"],
    });
  });
});
