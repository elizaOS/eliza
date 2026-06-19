import assert from "node:assert";
import { describe, it } from "vitest";
import { SelectList } from "../src/components/select-list.js";

const testTheme = {
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
};

describe("SelectList", () => {
  it("normalizes multiline descriptions to single line", () => {
    const items = [
      {
        value: "test",
        label: "test",
        description: "Line one\nLine two\nLine three",
      },
    ];

    const list = new SelectList(items, 5, testTheme);
    const rendered = list.render(100);

    assert.ok(rendered.length > 0);
    assert.ok(!rendered[0].includes("\n"));
    assert.ok(rendered[0].includes("Line one Line two Line three"));
  });

  it("renders at least one option when maxVisible is zero or negative", () => {
    const items = [
      { value: "one", label: "one" },
      { value: "two", label: "two" },
    ];

    for (const maxVisible of [0, -3]) {
      const list = new SelectList(items, maxVisible, testTheme);
      const rendered = list.render(20);

      assert.ok(
        rendered.some((line) => line.includes("one")),
        `expected visible option for maxVisible=${maxVisible}`,
      );
      assert.strictEqual(list.getSelectedItem()?.value, "one");
    }
  });
});
