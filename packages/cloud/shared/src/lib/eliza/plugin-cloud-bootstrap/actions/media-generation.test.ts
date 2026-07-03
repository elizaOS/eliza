import { describe, expect, test } from "bun:test";
import { type IAgentRuntime, type Memory, ModelType, ServiceType } from "@elizaos/core";
import { CloudMediaGenerationService } from "../services/cloud-media-generation-service";
import { generateMediaAction } from "./media-generation";

interface RuntimeOptions {
  cloudKey?: string | null;
  imageModelRegistered?: boolean;
}

/**
 * Builds a runtime whose media surface mirrors the cloud agent: plugin-elizacloud
 * registers the ModelType.IMAGE handler statically (present even without a key),
 * and ELIZAOS_CLOUD_API_KEY is the credential the image path authenticates with.
 */
function createRuntime(options: RuntimeOptions): {
  runtime: IAgentRuntime;
  service: CloudMediaGenerationService;
} {
  const { cloudKey = null, imageModelRegistered = true } = options;

  const runtime = {
    agentId: "agent-cloud-1",
    getSetting: (key: string) => (key === "ELIZAOS_CLOUD_API_KEY" ? cloudKey : null),
    getModel: (modelType: string) =>
      modelType === ModelType.IMAGE && imageModelRegistered ? async () => [] : undefined,
  } as unknown as IAgentRuntime & {
    getService: (serviceType: string) => CloudMediaGenerationService | null;
  };

  const service = new CloudMediaGenerationService(runtime);
  runtime.getService = (serviceType: string) =>
    serviceType === ServiceType.MEDIA_GENERATION ? service : null;

  return { runtime, service };
}

function imageMessage(text = "generate an image of a cat wearing a space helmet"): Memory {
  return {
    agentId: "agent-cloud-1",
    entityId: "user-1",
    roomId: "room-1",
    content: { text },
  } as Memory;
}

function runValidate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
  const validate = generateMediaAction.validate;
  if (!validate) {
    throw new Error("generateMediaAction.validate is not defined");
  }
  return validate(runtime, message) as Promise<boolean>;
}

describe("CloudMediaGenerationService.canGenerateMedia (#11953 health gate)", () => {
  test("true when the cloud media key is present and an IMAGE model is registered", () => {
    const { service } = createRuntime({ cloudKey: "sk-live-key", imageModelRegistered: true });
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(true);
  });

  test("false when the cloud media key is absent (registered handler is not enough)", () => {
    const { service } = createRuntime({ cloudKey: null, imageModelRegistered: true });
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(false);
  });

  test("false when the cloud media key is empty/whitespace", () => {
    const { service } = createRuntime({ cloudKey: "   ", imageModelRegistered: true });
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(false);
  });

  test("false when no IMAGE model handler is registered", () => {
    const { service } = createRuntime({ cloudKey: "sk-live-key", imageModelRegistered: false });
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(false);
  });

  test("false for non-image media types (cloud supports image only)", () => {
    const { service } = createRuntime({ cloudKey: "sk-live-key", imageModelRegistered: true });
    expect(service.canGenerateMedia({ mediaType: "video" })).toBe(false);
    expect(service.canGenerateMedia({ mediaType: "audio" })).toBe(false);
  });
});

describe("GENERATE_MEDIA validate honesty gate (#11953)", () => {
  test("withholds the tool when the cloud media key is missing — no false 'generating now'", async () => {
    const { runtime } = createRuntime({ cloudKey: null, imageModelRegistered: true });
    expect(await runValidate(runtime, imageMessage())).toBe(false);
  });

  test("exposes the tool when the cloud media key is present (unchanged behavior)", async () => {
    const { runtime } = createRuntime({ cloudKey: "sk-live-key", imageModelRegistered: true });
    expect(await runValidate(runtime, imageMessage())).toBe(true);
  });

  test("withholds the tool when no IMAGE model handler is registered", async () => {
    const { runtime } = createRuntime({ cloudKey: "sk-live-key", imageModelRegistered: false });
    expect(await runValidate(runtime, imageMessage())).toBe(false);
  });
});
