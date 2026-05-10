/**
 * Launch-time invariant test: no TCC dialogs on a fresh app open.
 *
 * Specifically: when the iMessage service starts, it must NOT call
 * `loadContacts()`. Calling it would shell out to Contacts.app via
 * AppleScript and trigger the macOS Contacts TCC dialog at app launch
 * — which is exactly the boot-time prompt we are eliminating.
 *
 * The contact map is now loaded lazily on the first inbound message that
 * needs handle→name resolution (see `IMessageService.ensureContactsLoaded`).
 *
 * If you find yourself "fixing" this test by re-adding `loadContacts()` to
 * `IMessageService.start()`, please don't. Add the lazy call to the
 * specific feature path that actually needs it instead.
 */

import { describe, expect, it, vi } from "vitest";

const { loadContactsMock } = vi.hoisted(() => ({
  loadContactsMock: vi.fn(async () => new Map()),
}));

vi.mock("../src/contacts-reader.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/contacts-reader.js")
  >("../src/contacts-reader.js");
  return {
    ...actual,
    loadContacts: loadContactsMock,
  };
});

// chatdb-reader's openChatDb returns null on non-Bun / non-macOS test envs,
// so the service degrades to send-only without filesystem side effects.

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { IMessageService } from "../src/service.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    character: { name: "test" },
    getSetting: vi.fn(() => undefined),
    emitEvent: vi.fn(),
    registerTaskWorker: vi.fn(),
    createTask: vi.fn(),
    getTasks: vi.fn(async () => []),
    deleteTask: vi.fn(),
    registerMessageConnector: vi.fn(),
    registerSendHandler: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("iMessage launch-time permission invariant", () => {
  it("does not call loadContacts() during IMessageService.start()", async () => {
    loadContactsMock.mockClear();

    if (process.platform !== "darwin") {
      // The service throws IMessageNotSupportedError on non-macOS before it
      // would have called loadContacts, which still satisfies the invariant
      // but doesn't exercise the deferred path. Skip with a clear note so
      // CI on Linux/Windows doesn't false-positive.
      return;
    }

    const runtime = makeRuntime();

    try {
      await IMessageService.start(runtime);
    } catch {
      // Service start can fail in test envs (no chat.db, no Contacts access,
      // etc.) — that's fine. The only thing this test cares about is whether
      // loadContacts was invoked synchronously during boot.
    }

    expect(loadContactsMock).not.toHaveBeenCalled();
  });
});
