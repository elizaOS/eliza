import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "ContactsAppView.tsx"),
  "utf8",
);

describe("Contacts visual copy", () => {
  it("uses icons instead of raw starred-state glyphs in the TUI row", () => {
    expect(source).not.toContain('contact.starred ? "*" : "-"');
    expect(source).toContain("<Star");
    expect(source).toContain("aria-label={contact.starred");
  });
});
