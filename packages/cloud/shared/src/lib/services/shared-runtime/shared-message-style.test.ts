import { expect, test } from "bun:test";
import { formatSharedMessageText } from "./shared-message-style";

test("renders plain headings without altering code, math, or arbitrary asterisks", () => {
  expect(
    formatSharedMessageText(
      "**Headline limits (per project):**\n- 1,200,000 quota units per minute\n# Method costs",
    ),
  ).toBe("Headline limits (per project):\n- 1,200,000 quota units per minute\nMethod costs");
  const literal =
    "2 ** 3 = 8\na*b\n**wildcard**\nUse `messages.get`\n```md\n```python\n# Heading\n**Label:**\n```\n~~~python\nx = 2 ** 3\n~~~";
  expect(formatSharedMessageText(literal)).toBe(literal);
  const indentedCode = "    # Python comment\n    print(1)\n\t# Shell comment\n\tprintf hello";
  expect(formatSharedMessageText(indentedCode)).toBe(indentedCode);
});
