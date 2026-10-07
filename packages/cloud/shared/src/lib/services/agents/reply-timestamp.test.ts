import { describe, expect, test } from "bun:test";
import { agentReplyTimestamp } from "./reply-timestamp";

describe("agentReplyTimestamp", () => {
  test("keeps a reply created at epoch", () => {
    expect(agentReplyTimestamp(0).toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  test("uses now when the reply has no created time", () => {
    expect(agentReplyTimestamp(undefined, 1_700_000_000_000).toISOString()).toBe(
      "2023-11-14T22:13:20.000Z",
    );
  });
});
