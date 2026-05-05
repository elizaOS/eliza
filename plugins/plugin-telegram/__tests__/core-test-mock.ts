import { vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  const { createHash } = await import("node:crypto");

  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };

  const ChannelType = {
    API: "API",
    DM: "DM",
    FEED: "FEED",
    GROUP: "GROUP",
    SELF: "SELF",
    THREAD: "THREAD",
    VOICE_DM: "VOICE_DM",
    VOICE_GROUP: "VOICE_GROUP",
    WORLD: "WORLD",
  } as const;

  const EventType = {
    MESSAGE_RECEIVED: "MESSAGE_RECEIVED",
    MESSAGE_SENT: "MESSAGE_SENT",
    REACTION_RECEIVED: "REACTION_RECEIVED",
    WORLD_JOINED: "WORLD_JOINED",
  } as const;

  const ModelType = {
    IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
  } as const;

  const Role = {
    ADMIN: "ADMIN",
    GUEST: "GUEST",
    MEMBER: "MEMBER",
    NONE: "NONE",
    OWNER: "OWNER",
  } as const;

  const ServiceType = {
    PDF: "pdf",
  } as const;

  function stringToUuid(target: string | number): string {
    const value = typeof target === "number" ? String(target) : target;
    if (typeof value !== "string") {
      throw new TypeError("Value must be string");
    }
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      return value;
    }

    const bytes = createHash("sha1")
      .update(encodeURIComponent(value))
      .digest()
      .subarray(0, 16);
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes[6] = bytes[6] & 0x0f;

    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16,
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  class Service {
    protected runtime: unknown;

    constructor(runtime?: unknown) {
      this.runtime = runtime;
    }
  }

  return {
    ChannelType,
    EventType,
    ModelType,
    Role,
    Service,
    ServiceType,
    createUniqueUuid: (runtime: { agentId: string }, baseUserId: string) =>
      baseUserId === runtime.agentId
        ? runtime.agentId
        : stringToUuid(`${baseUserId}:${runtime.agentId}`),
    lifeOpsPassiveConnectorsEnabled: () => true,
    logger,
    stringToUuid,
  };
});
