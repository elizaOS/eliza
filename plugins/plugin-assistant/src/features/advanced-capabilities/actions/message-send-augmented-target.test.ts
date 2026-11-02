/**
 * Send-target/source inference on an augmented turn (change request on
 * #38433, ss251 2026-11-01): the document-augmentation envelope sits in
 * content.text, so text inference must read the user's words inside
 * <user_request>, not the whole envelope. A document fragment naming
 * @alice must not select the target or source when the user asked to send
 * to @bob, and a plain (unwrapped) message must still yield a non-empty
 * inference so send does not silently drop to the ask path.
 *
 * normalizeSendParams is private, so the tests use the test-only
 * __testNormalizeSendParams export, following the __test* precedent in
 * message.ts. No send is performed; only the normalized parameters are
 * inspected.
 */

import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { __testNormalizeSendParams } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;

const CONNECTORS = [
  { source: "discord", label: "discord" },
  { source: "telegram", label: "telegram" },
] as unknown as Parameters<typeof __testNormalizeSendParams>[3];

function msg(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000b1" as UUID,
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "discord" },
  } as Memory;
}

function augmented(userRequest: string, documentFragment: string): string {
  return [
    "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
    "If the answer appears verbatim in the contextual documents, repeat it exactly.",
    "",
    "<contextual_documents>",
    '<source title="contacts" similarity="0.900">',
    documentFragment,
    "</source>",
    "</contextual_documents>",
    "",
    "<user_request>",
    userRequest,
    "</user_request>",
  ].join("\n");
}

describe("MESSAGE send inference on an augmented turn", () => {
  it("resolves the explicit user-typed target on a plain message", () => {
    const params = __testNormalizeSendParams(
      {},
      msg("Send a message to @bob on discord saying hello."),
      undefined,
      CONNECTORS,
    );
    expect(params.target).toBe("@bob");
    expect(params.source).toBe("discord");
  });

  it("does not let a document fragment select the target or source", () => {
    const params = __testNormalizeSendParams(
      {},
      msg(
        augmented(
          "Send a message to @bob on discord saying hello.",
          "To reach the team, send a message to @alice on telegram.",
        ),
      ),
      undefined,
      CONNECTORS,
    );
    expect(params.target).toBe("@bob");
    expect(params.source).toBe("discord");
  });

  it("keeps plain, unwrapped messages yielding a target", () => {
    const params = __testNormalizeSendParams(
      {},
      msg("Tell @carol the meeting moved."),
      undefined,
      CONNECTORS,
    );
    expect(params.target).toBe("@carol");
  });
});
