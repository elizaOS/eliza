import { EventEmitter } from "node:events";
import type http from "node:http";
import { expect, it } from "vitest";
import { createConversationStreamDisconnectTracker } from "../src/api/conversation-routes.ts";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";

it.each([
  { continueOnDisconnect: false, generationAborted: true },
  { continueOnDisconnect: true, generationAborted: false },
])(
  "handles a closed conversation stream with continueOnDisconnect=$continueOnDisconnect",
  ({ continueOnDisconnect, generationAborted }) => {
    const req = new EventEmitter() as http.IncomingMessage;
    const res = new EventEmitter() as http.ServerResponse;
    const tracker = createConversationStreamDisconnectTracker({
      req,
      res,
      conversationId: "conversation",
      roomId: "00000000-0000-4000-8000-000000000000",
      continueOnDisconnect,
    });
    res.emit("close");
    expect(tracker.isAborted()).toBe(true);
    expect(tracker.checkConnectionClosed()).toBe(continueOnDisconnect);
    expect(tracker.signal.aborted).toBe(generationAborted);
    tracker.dispose();
  },
);

it("cancels detached generation when its paired session is revoked", () => {
  const original = getAgentHostBridge();
  let notify: ((sessionId: string | null) => void) | undefined;
  setAgentHostBridge({
    ...original,
    subscribeSessionRevocations: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    resolveSessionTokenAuthorization: () => ({ ok: true, role: "USER" }),
  });
  try {
    const req = new EventEmitter() as http.IncomingMessage;
    const res = new EventEmitter() as http.ServerResponse;
    const tracker = createConversationStreamDisconnectTracker({
      req,
      res,
      conversationId: "conversation",
      roomId: "00000000-0000-4000-8000-000000000000",
      continueOnDisconnect: true,
      pairedSessionToken: "paired-token",
    });
    res.emit("close");
    expect(tracker.signal.aborted).toBe(false);
    notify?.("other-token");
    expect(tracker.signal.aborted).toBe(false);
    notify?.("paired-token");
    expect(tracker.signal.aborted).toBe(true);
    tracker.dispose();
    expect(notify).toBeUndefined();
  } finally {
    setAgentHostBridge(original);
  }
});

it("rejects a pairing revoked before tracker setup and preserves a bulk-revoke exception", async () => {
  const original = getAgentHostBridge();
  let notify: ((sessionId: string | null) => void) | undefined;
  let valid = true;
  setAgentHostBridge({
    ...original,
    subscribeSessionRevocations: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    resolveSessionTokenAuthorization: () => ({ ok: valid, role: "USER" }),
  });
  try {
    const req = new EventEmitter() as http.IncomingMessage;
    const res = new EventEmitter() as http.ServerResponse;
    const tracker = createConversationStreamDisconnectTracker({
      req,
      res,
      conversationId: "conversation",
      roomId: "00000000-0000-4000-8000-000000000000",
      continueOnDisconnect: true,
      pairedSessionToken: "paired-token",
    });
    res.emit("close");
    notify?.(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.signal.aborted).toBe(false);
    valid = false;
    notify?.(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.signal.aborted).toBe(true);
    tracker.dispose();

    const alreadyRevoked = createConversationStreamDisconnectTracker({
      req: new EventEmitter() as http.IncomingMessage,
      res: new EventEmitter() as http.ServerResponse,
      conversationId: "conversation",
      roomId: "00000000-0000-4000-8000-000000000000",
      continueOnDisconnect: true,
      pairedSessionToken: "paired-token",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(alreadyRevoked.signal.aborted).toBe(true);
    alreadyRevoked.dispose();
  } finally {
    setAgentHostBridge(original);
  }
});
