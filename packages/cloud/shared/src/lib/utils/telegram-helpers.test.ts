import { describe, expect, test } from "bun:test";
import { convertToTelegramMarkdown } from "./telegram-helpers";

describe("convertToTelegramMarkdown", () => {
  test("keeps underscores inside an identifier escaped", () => {
    expect(convertToTelegramMarkdown("hello_world_test")).toBe("hello\\_world\\_test");
  });

  test("still turns a wrapped underscore span into italic", () => {
    expect(convertToTelegramMarkdown("Say _hello_ there")).toBe("Say _hello_ there");
  });
});
