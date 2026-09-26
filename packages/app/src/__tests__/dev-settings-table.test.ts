import { describe, expect, it } from "vitest";
import {
  boxRow,
  formatDevSettingsTable,
  wrapToWidth,
} from "../dev-settings-table";

describe("dev settings table boundaries", () => {
  it.each([NaN, Infinity, -1, 0, 0.5])(
    "rejects invalid wrap width %s",
    (width) => {
      expect(() => wrapToWidth("long text", width)).toThrow(RangeError);
      expect(() =>
        formatDevSettingsTable("settings", [], { narrowWidth: width }),
      ).toThrow(RangeError);
    },
  );

  it("preserves complete Unicode when wrapping hard boundaries", () => {
    expect(wrapToWidth("a😀b", 2)).toEqual(["a", "😀", "b"]);
    expect(wrapToWidth("😀", 1)).toEqual(["😀"]);
  });

  it("supports numeric column caps and rejects invalid caps", () => {
    expect(
      formatDevSettingsTable("settings", [], {
        layout: "wide",
        caps: { setting: 3 },
      }),
    ).toContain("Se…");
    expect(() =>
      formatDevSettingsTable("settings", [], {
        layout: "wide",
        caps: { setting: NaN },
      }),
    ).toThrow(RangeError);
  });

  it("handles a frame with no text budget without negative padding", () => {
    expect(boxRow("text", 6)).toBe("│  │");
    expect(() => boxRow("text", 5)).toThrow(RangeError);
  });
});
