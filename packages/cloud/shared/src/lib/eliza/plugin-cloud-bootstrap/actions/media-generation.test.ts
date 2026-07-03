import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { type IAgentRuntime, type Memory, ModelType, ServiceType } from "@elizaos/core";
import { CloudMediaGenerationService } from "../services/cloud-media-generation-service";
import { generateMediaAction } from "./media-generation";

const GENERATED_IMAGE_URL = "https://cdn.example.com/generated.png";
const HEALTH_RECHECK_COOLDOWN_MS = 5 * 60 * 1000;

interface RuntimeOptions {
  cloudKey?: string | null;
  imageModelRegistered?: boolean;
  /** Controls what the IMAGE model does when `generateMedia` runs. */
  useModel?: () => Promise<unknown>;
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
    useModel: options.useModel ?? (async () => [GENERATED_IMAGE_URL]),
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

/**
 * The key-presence gate above proves a key is CONFIGURED — not that it is VALID.
 * A present-but-invalid/expired key (the literal #11953 title) passes the
 * presence check yet 401s on every call. The health breaker catches that at call
 * time so the action still drops from the catalog instead of promising-then-
 * failing, and self-heals once the key is rotated.
 */
describe("CloudMediaGenerationService health breaker — present-but-invalid key (#11953)", () => {
  afterEach(() => setSystemTime()); // reset any faked clock

  test("opens after an invalid/expired-key failure so a keyed-but-dead provider drops from the catalog", async () => {
    const { service } = createRuntime({
      cloudKey: "sk-live-but-revoked",
      useModel: async () => {
        throw new Error("Media generation failed: Invalid or expired API key");
      },
    });
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(true); // key present → optimistic

    await expect(service.generateMedia({ mediaType: "image", prompt: "a cat" })).rejects.toThrow(
      /Invalid or expired API key/,
    );

    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(false); // breaker open
  });

  test("does NOT open on a per-request (content-policy) failure — the tool stays available", async () => {
    const { service } = createRuntime({
      cloudKey: "sk-live-key",
      useModel: async () => {
        throw new Error("Your prompt was rejected by the content policy");
      },
    });
    await expect(service.generateMedia({ mediaType: "image", prompt: "x" })).rejects.toThrow();
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(true);
  });

  test("half-opens after the cooldown to allow a re-probe", async () => {
    const base = Date.parse("2026-07-03T00:00:00Z");
    setSystemTime(new Date(base));
    const { service } = createRuntime({
      cloudKey: "sk-live-but-revoked",
      useModel: async () => {
        throw new Error("401 Unauthorized");
      },
    });

    await expect(service.generateMedia({ mediaType: "image", prompt: "x" })).rejects.toThrow();
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(false);

    setSystemTime(new Date(base + HEALTH_RECHECK_COOLDOWN_MS - 1000));
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(false); // still cooling down

    setSystemTime(new Date(base + HEALTH_RECHECK_COOLDOWN_MS));
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(true); // half-open re-probe
  });

  test("closes the breaker after a successful generation (self-heals once the key is rotated)", async () => {
    let keyDead = true;
    const { service } = createRuntime({
      cloudKey: "sk-live-key",
      useModel: async () => {
        if (keyDead) throw new Error("Invalid or expired API key");
        return [GENERATED_IMAGE_URL];
      },
    });

    await expect(service.generateMedia({ mediaType: "image", prompt: "x" })).rejects.toThrow();
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(false);

    keyDead = false; // operator rotated the key
    const res = await service.generateMedia({ mediaType: "image", prompt: "x" });
    expect(res.url).toBe(GENERATED_IMAGE_URL);
    expect(service.canGenerateMedia({ mediaType: "image" })).toBe(true);
  });
});
