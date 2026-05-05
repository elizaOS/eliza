import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// Mock nostr-tools before importing modules that use it
vi.mock("nostr-tools", () => {
  return {
    nip19: {
      decode: vi.fn((input: string) => {
        if (input.startsWith("npub1")) {
          return {
            type: "npub",
            data: new Uint8Array(32).fill(0x7e),
          };
        }
        if (input.startsWith("nsec1")) {
          return {
            type: "nsec",
            data: new Uint8Array(32).fill(0xab),
          };
        }
        throw new Error("Invalid nip19 string");
      }),
      npubEncode: vi.fn(() => "npub1mockencoded"),
    },
    getPublicKey: vi.fn(() => "a".repeat(64)),
    finalizeEvent: vi.fn(() => ({
      id: "mock_event_id",
      pubkey: "a".repeat(64),
      created_at: 1700000000,
      kind: 4,
      tags: [],
      content: "encrypted",
      sig: "mock_sig",
    })),
    verifyEvent: vi.fn(() => true),
    SimplePool: vi.fn().mockImplementation(() => ({
      publish: vi.fn().mockResolvedValue(undefined),
      subscribeMany: vi.fn(),
      close: vi.fn(),
    })),
  };
});

vi.mock("nostr-tools/nip04", () => ({
  encrypt: vi.fn(() => "encrypted_content"),
  decrypt: vi.fn(() => "decrypted_content"),
}));

vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    Service: class MockService {
      protected runtime: IAgentRuntime = {} as IAgentRuntime;
      constructor(runtime?: IAgentRuntime) {
        if (runtime) this.runtime = runtime;
      }
    },
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    composePromptFromState: vi.fn().mockResolvedValue("mock prompt"),
    parseJSONObjectFromText: vi.fn(),
    ModelType: { TEXT_SMALL: "TEXT_SMALL" },
  };
});

import { publishProfile } from "../actions/publishProfile.js";
import { sendDm } from "../actions/sendDm.js";
import { identityContextProvider } from "../providers/identityContext.js";
import { senderContextProvider } from "../providers/senderContext.js";
import {
  DEFAULT_NOSTR_RELAYS,
  getPubkeyDisplayName,
  isValidPubkey,
  MAX_NOSTR_MESSAGE_LENGTH,
  NOSTR_SERVICE_NAME,
  NostrConfigurationError,
  NostrCryptoError,
  NostrEventTypes,
  NostrPluginError,
  NostrRelayError,
  normalizePubkey,
  splitMessageForNostr,
  validatePrivateKey,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

describe("Nostr Constants", () => {
  it("MAX_NOSTR_MESSAGE_LENGTH is 4000", () => {
    expect(MAX_NOSTR_MESSAGE_LENGTH).toBe(4000);
  });

  it("NOSTR_SERVICE_NAME is 'nostr'", () => {
    expect(NOSTR_SERVICE_NAME).toBe("nostr");
  });

  it("DEFAULT_NOSTR_RELAYS has 3 entries", () => {
    expect(DEFAULT_NOSTR_RELAYS).toHaveLength(3);
    expect(DEFAULT_NOSTR_RELAYS).toContain("wss://relay.damus.io");
    expect(DEFAULT_NOSTR_RELAYS).toContain("wss://nos.lol");
    expect(DEFAULT_NOSTR_RELAYS).toContain("wss://relay.nostr.band");
  });
});

// ============================================================================
// Event Types
// ============================================================================

describe("NostrEventTypes", () => {
  it("has correct enum values", () => {
    expect(NostrEventTypes.MESSAGE_RECEIVED).toBe("NOSTR_MESSAGE_RECEIVED");
    expect(NostrEventTypes.MESSAGE_SENT).toBe("NOSTR_MESSAGE_SENT");
    expect(NostrEventTypes.RELAY_CONNECTED).toBe("NOSTR_RELAY_CONNECTED");
    expect(NostrEventTypes.RELAY_DISCONNECTED).toBe("NOSTR_RELAY_DISCONNECTED");
    expect(NostrEventTypes.PROFILE_PUBLISHED).toBe("NOSTR_PROFILE_PUBLISHED");
    expect(NostrEventTypes.CONNECTION_READY).toBe("NOSTR_CONNECTION_READY");
  });
});

// ============================================================================
// Utility Functions
// ============================================================================

describe("isValidPubkey", () => {
  it("returns true for valid hex pubkey", () => {
    const valid = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
    expect(isValidPubkey(valid)).toBe(true);
  });

  it("returns false for too-short hex", () => {
    expect(isValidPubkey("7e7e9c42a91bfef19fa929e5fda1b72e")).toBe(false);
  });

  it("returns false for invalid characters", () => {
    const invalid = "zzzz9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
    expect(isValidPubkey(invalid)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidPubkey("")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isValidPubkey(12345 as never)).toBe(false);
  });
});

describe("normalizePubkey", () => {
  it("lowercases hex pubkey", () => {
    const upper = "7E7E9C42A91BFEF19FA929E5FDA1B72E0EBC1A4C1141673E2794234D86ADDF4E";
    const result = normalizePubkey(upper);
    expect(result).toBe(upper.toLowerCase());
  });

  it("trims whitespace", () => {
    const padded = "  7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e  ";
    const result = normalizePubkey(padded);
    expect(result).toBe("7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e");
  });

  it("throws for invalid pubkey", () => {
    expect(() => normalizePubkey("invalid")).toThrow(NostrCryptoError);
  });
});

describe("validatePrivateKey", () => {
  it("validates hex private key", () => {
    const hex = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
    const result = validatePrivateKey(hex);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  it("throws for invalid key", () => {
    expect(() => validatePrivateKey("invalid")).toThrow(NostrCryptoError);
  });

  it("throws for too-short key", () => {
    expect(() => validatePrivateKey("abcdef")).toThrow(NostrCryptoError);
  });
});

describe("getPubkeyDisplayName", () => {
  it("returns truncated display name", () => {
    const pubkey = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
    const display = getPubkeyDisplayName(pubkey);
    expect(display).toContain("7e7e9c42");
    expect(display).toContain("86addf4e");
    expect(display).toContain("...");
  });
});

describe("splitMessageForNostr", () => {
  it("returns single chunk for short message", () => {
    const result = splitMessageForNostr("Hello!");
    expect(result).toEqual(["Hello!"]);
  });

  it("returns single chunk at exact limit", () => {
    const text = "a".repeat(MAX_NOSTR_MESSAGE_LENGTH);
    const result = splitMessageForNostr(text);
    expect(result).toHaveLength(1);
  });

  it("splits long messages", () => {
    const text = "a".repeat(5000);
    const result = splitMessageForNostr(text, 1000);
    expect(result.length).toBeGreaterThan(1);
    result.forEach((chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    });
  });

  it("preserves all content", () => {
    const text = "Hello world this is a test message";
    const chunks = splitMessageForNostr(text, 20);
    const joined = chunks.join(" ");
    expect(joined).toContain("Hello");
    expect(joined).toContain("message");
  });
});

// ============================================================================
// Error Types
// ============================================================================

describe("Error types", () => {
  it("NostrPluginError has code and message", () => {
    const err = new NostrPluginError("test", "TEST_CODE");
    expect(err.message).toBe("test");
    expect(err.code).toBe("TEST_CODE");
    expect(err.name).toBe("NostrPluginError");
  });

  it("NostrConfigurationError has setting", () => {
    const err = new NostrConfigurationError("Missing key", "NOSTR_PRIVATE_KEY");
    expect(err.code).toBe("CONFIGURATION_ERROR");
    expect(err.setting).toBe("NOSTR_PRIVATE_KEY");
    expect(err).toBeInstanceOf(NostrPluginError);
  });

  it("NostrRelayError has relay", () => {
    const err = new NostrRelayError("Timeout", "wss://relay.example.com");
    expect(err.code).toBe("RELAY_ERROR");
    expect(err.relay).toBe("wss://relay.example.com");
  });

  it("NostrCryptoError", () => {
    const err = new NostrCryptoError("Invalid key");
    expect(err.code).toBe("CRYPTO_ERROR");
  });
});

// ============================================================================
// Actions
// ============================================================================

describe("sendDm action", () => {
  it("has correct name", () => {
    expect(sendDm.name).toBe("NOSTR_SEND_DM");
  });

  it("has description mentioning encrypted", () => {
    expect(sendDm.description.toLowerCase()).toContain("encrypted");
  });

  it("has similes", () => {
    expect(sendDm.similes).toContain("SEND_NOSTR_DM");
    expect(sendDm.similes).toContain("NOSTR_MESSAGE");
    expect(sendDm.similes).toContain("NOSTR_TEXT");
    expect(sendDm.similes).toContain("DM_NOSTR");
  });

  it("has validate function", () => {
    expect(typeof sendDm.validate).toBe("function");
  });

  it("has handler function", () => {
    expect(typeof sendDm.handler).toBe("function");
  });

  it("has examples", () => {
    expect(sendDm.examples).toBeDefined();
    expect(sendDm.examples?.length).toBeGreaterThan(0);
  });

  it("validate returns true for nostr source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "nostr" } } as Memory;
    const result = await sendDm.validate(runtime, message);
    expect(result).toBe(true);
  });

  it("validate returns false for non-nostr source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "discord" } } as Memory;
    const result = await sendDm.validate(runtime, message);
    expect(result).toBe(false);
  });
});

describe("publishProfile action", () => {
  it("has correct name", () => {
    expect(publishProfile.name).toBe("NOSTR_PUBLISH_PROFILE");
  });

  it("has description mentioning profile", () => {
    expect(publishProfile.description.toLowerCase()).toContain("profile");
  });

  it("has similes", () => {
    expect(publishProfile.similes).toContain("UPDATE_NOSTR_PROFILE");
    expect(publishProfile.similes).toContain("SET_NOSTR_PROFILE");
    expect(publishProfile.similes).toContain("NOSTR_PROFILE");
  });

  it("validate returns true for nostr source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "nostr" } } as Memory;
    const result = await publishProfile.validate(runtime, message);
    expect(result).toBe(true);
  });

  it("validate returns false for non-nostr source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "telegram" } } as Memory;
    const result = await publishProfile.validate(runtime, message);
    expect(result).toBe(false);
  });
});

// ============================================================================
// Providers
// ============================================================================

describe("identityContextProvider", () => {
  it("has correct name", () => {
    expect(identityContextProvider.name).toBe("nostrIdentityContext");
  });

  it("has description", () => {
    expect(identityContextProvider.description).toBeDefined();
    expect(identityContextProvider.description?.toLowerCase()).toContain("identity");
  });

  it("returns empty for non-nostr source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "discord" } } as Memory;
    const state = {} as State;

    const result = await identityContextProvider.get(runtime, message, state);

    expect(result.text).toBe("");
  });

  it("returns disconnected when no service", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue(null),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "nostr" } } as Memory;
    const state = {} as State;

    const result = await identityContextProvider.get(runtime, message, state);

    expect(result.data).toHaveProperty("connected", false);
  });

  it("returns identity when connected", async () => {
    const mockService = {
      isConnected: vi.fn().mockReturnValue(true),
      getPublicKey: vi.fn().mockReturnValue("a".repeat(64)),
      getNpub: vi.fn().mockReturnValue("npub1test"),
      getRelays: vi.fn().mockReturnValue(["wss://relay.damus.io"]),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "nostr" } } as Memory;
    const state = { agentName: "TestBot" } as State;

    const result = await identityContextProvider.get(runtime, message, state);

    expect(result.data).toHaveProperty("connected", true);
    expect(result.data).toHaveProperty("publicKey", "a".repeat(64));
    expect(result.data).toHaveProperty("npub", "npub1test");
    expect(result.text).toContain("TestBot");
    expect(result.text).toContain("Nostr");
  });
});

describe("senderContextProvider", () => {
  it("has correct name", () => {
    expect(senderContextProvider.name).toBe("nostrSenderContext");
  });

  it("has description", () => {
    expect(senderContextProvider.description).toBeDefined();
    expect(senderContextProvider.description?.toLowerCase()).toContain("user");
  });

  it("returns empty for non-nostr source", async () => {
    const runtime = {} as IAgentRuntime;
    const message = { content: { source: "telegram" } } as Memory;
    const state = {} as State;

    const result = await senderContextProvider.get(runtime, message, state);

    expect(result.text).toBe("");
  });

  it("returns empty when no sender pubkey", async () => {
    const mockService = {
      isConnected: vi.fn().mockReturnValue(true),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "nostr" } } as Memory;
    const state = { data: {} } as State;

    const result = await senderContextProvider.get(runtime, message, state);

    expect(result.text).toBe("");
  });

  it("returns sender context when pubkey present", async () => {
    const senderPk = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
    const mockService = {
      isConnected: vi.fn().mockReturnValue(true),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const message = { content: { source: "nostr" } } as Memory;
    const state = {
      agentName: "Bot",
      data: { senderPubkey: senderPk },
    } as State;

    const result = await senderContextProvider.get(runtime, message, state);

    expect(result.data).toHaveProperty("senderPubkey", senderPk);
    expect(result.data).toHaveProperty("isEncrypted", true);
    expect(result.text).toContain("Bot");
    expect(result.text).toContain("NIP-04");
  });
});
