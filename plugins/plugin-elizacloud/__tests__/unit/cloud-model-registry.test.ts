import { describe, expect, test } from "vitest";
import {
  type AvailableModel,
  resolveAvailableCloudModelId,
} from "../../services/cloud-model-registry";

const availableModels = [
  {
    id: "openai/gpt-oss-120b",
    provider: "openai",
    name: "gpt-oss-120b",
    createdAt: 0,
  },
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openai",
    name: "gpt-oss-120b:free",
    createdAt: 0,
  },
] satisfies AvailableModel[];

describe("resolveAvailableCloudModelId", () => {
  test("keeps available exact model IDs", () => {
    expect(resolveAvailableCloudModelId("openai/gpt-oss-120b:free", availableModels)).toBe(
      "openai/gpt-oss-120b:free"
    );
  });

  test("resolves the retired nitro alias to the available base model", () => {
    expect(resolveAvailableCloudModelId("openai/gpt-oss-120b:nitro", availableModels)).toBe(
      "openai/gpt-oss-120b"
    );
  });

  test("preserves unknown configured models when the registry cannot prove a replacement", () => {
    expect(resolveAvailableCloudModelId("anthropic/claude-future", availableModels)).toBe(
      "anthropic/claude-future"
    );
  });
});
