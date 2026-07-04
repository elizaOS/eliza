/**
 * Shared Vitest mock for music tests that need core services without loading
 * the full runtime.
 */
import { vi } from "vitest";

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
    CONTEXT_ROUTING_STATE_KEY: "__contextRouting",
    ChannelType: {
      DM: "DM",
    },
    ModelType: {
      TEXT_LARGE: "TEXT_LARGE",
      TEXT_SMALL: "TEXT_SMALL",
    },
    gateDestructiveConfirmation: vi.fn(async (args) => {
      await args.callback?.({
        text: args.prompt,
        source: args.message?.content?.source,
      });
      return { status: "pending" };
    }),
    getActiveRoutingContextsForTurn: vi.fn(() => []),
    parseKeyValueXml: (xml: string) => {
      const result: Record<string, string> = {};
      for (const match of xml.matchAll(/<([a-zA-Z0-9_:-]+)>([^<]*)<\/\1>/g)) {
        result[match[1]] = match[2];
      }
      return result;
    },
    promoteSubactionsToActions: (action: unknown) => [action],
    Service,
    logger,
  };
});
