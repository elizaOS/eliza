/**
 * Unit contract for escapeLikePattern: LIKE metacharacters in user search
 * text must be backslash-escaped so they match literally (Postgres' default
 * LIKE escape is the backslash), while ordinary text passes through unchanged.
 */
import { describe, expect, test } from "bun:test";

import { escapeLikePattern } from "../like-pattern";

describe("escapeLikePattern", () => {
  test("escapes %, _, and backslash", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("C:\\path")).toBe("C:\\\\path");
    expect(escapeLikePattern("%_%")).toBe("\\%\\_\\%");
  });

  test("passes ordinary text through unchanged", () => {
    expect(escapeLikePattern("my search term")).toBe("my search term");
    expect(escapeLikePattern("mcp-server 2")).toBe("mcp-server 2");
    expect(escapeLikePattern("")).toBe("");
    expect(escapeLikePattern("'*\"; DROP TABLE--")).toBe("'*\"; DROP TABLE--");
  });
});
