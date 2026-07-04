import type http from "node:http";
import type { ChatTurnStatus } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";

import { writeChatStatusSse } from "./chat-routes.ts";

/** Minimal ServerResponse stand-in capturing the bytes written to the wire. */
function makeRes(): {
  res: http.ServerResponse;
  writes: string[];
} {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  } as unknown as http.ServerResponse;
  return { res, writes };
}

describe("writeChatStatusSse (#8813)", () => {
  it("emits a single `type: status` SSE frame carrying the phase fields", () => {
    const { res, writes } = makeRes();
    writeChatStatusSse(res, {
      kind: "running_action",
      actionName: "SEND_MESSAGE",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith("data: ")).toBe(true);
    expect(writes[0].endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(writes[0].slice("data: ".length).trim());
    expect(payload).toEqual({
      type: "status",
      kind: "running_action",
      actionName: "SEND_MESSAGE",
    });
  });

  it("spreads only the provided ChatTurnStatus fields (no actionName when absent)", () => {
    const { res, writes } = makeRes();
    writeChatStatusSse(res, { kind: "thinking" });
    const payload = JSON.parse(writes[0].slice("data: ".length).trim());
    expect(payload).toEqual({ type: "status", kind: "thinking" });
  });

  it("does not write once the response is ended (closed connection)", () => {
    const { res, writes } = makeRes();
    (res as { writableEnded: boolean }).writableEnded = true;
    writeChatStatusSse(res, { kind: "streaming" });
    expect(writes).toHaveLength(0);
  });

  it("emits every kind in the shared ChatTurnStatus contract", () => {
    // The union comes from the single @elizaos/shared contract (#12409); this
    // asserts writeChatStatusSse renders each phase kind onto the wire.
    const kinds: ChatTurnStatus["kind"][] = [
      "thinking",
      "streaming",
      "running_action",
      "running_tool",
      "evaluating",
      "waking",
      "speaking",
    ];
    for (const kind of kinds) {
      const { res, writes } = makeRes();
      writeChatStatusSse(res, { kind });
      const payload = JSON.parse(writes[0].slice("data: ".length).trim());
      expect(payload.type).toBe("status");
      expect(payload.kind).toBe(kind);
    }
  });
});
