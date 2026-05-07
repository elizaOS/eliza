import { createHash } from "node:crypto";
import { vi } from "vitest";

function stringToUuid(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    return text;
  }

  const bytes = createHash("sha1").update(encodeURIComponent(text)).digest().subarray(0, 16);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  bytes[6] = bytes[6] & 0x0f;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

vi.mock("@elizaos/core", () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };

  class Service {
    protected runtime: unknown;

    constructor(runtime?: unknown) {
      this.runtime = runtime;
    }
  }

  return {
    ChannelType: {
      DM: "DM",
      GROUP: "GROUP",
    },
    EventType: {
      ENTITY_JOINED: "ENTITY_JOINED",
      MESSAGE_RECEIVED: "MESSAGE_RECEIVED",
      MESSAGE_SENT: "MESSAGE_SENT",
      REACTION_RECEIVED: "REACTION_RECEIVED",
      WORLD_JOINED: "WORLD_JOINED",
    },
    ModelType: {
      TEXT_SMALL: "TEXT_SMALL",
    },
    Service,
    composePromptFromState: vi.fn(() => ""),
    createUniqueUuid: (_runtime: { agentId?: string }, value: string) => stringToUuid(value),
    logger,
    parseJSONObjectFromText: (text: string) => JSON.parse(text),
    stringToUuid,
  };
});
