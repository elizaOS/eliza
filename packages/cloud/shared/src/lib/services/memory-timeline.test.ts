import { describe, expect, test } from "bun:test";
import { memoryTimelineDate } from "./memory-timeline";

describe("memoryTimelineDate", () => {
  test("keeps an epoch memory on the epoch day", () => {
    expect(memoryTimelineDate(0).toISOString().split("T")[0]).toBe("1970-01-01");
  });

  test("uses now when the memory has no created time", () => {
    expect(memoryTimelineDate(undefined, 1_700_000_000_000).toISOString()).toBe(
      "2023-11-14T22:13:20.000Z",
    );
  });
});
