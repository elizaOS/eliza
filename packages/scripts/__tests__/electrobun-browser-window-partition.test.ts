import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { patchElectrobunBrowserWindowSource } from "../lib/electrobun-browser-window-partition.ts";

// Read the pinned installed package without loading its native runtime. Undo
// only our known patches so these checks exercise the actual upstream source.
const installed = readFileSync(
  new URL(
    "../../app/platforms/electrobun/node_modules/electrobun/dist/api/bun/core/BrowserWindow.ts",
    import.meta.url,
  ),
  "utf8",
);
const upstream = installed
  .replace("\tptr!: Pointer | bigint;", "\tptr!: Pointer;")
  .replace("\tpartition?: string | null;\n", "")
  .replace("\t\t\tpartition: partition || null,\n", "")
  .replace("\t\tactivate,\n\t\tpartition,\n", "\t\tactivate,\n");
const digest = (source) => createHash("sha256").update(source).digest("hex");

describe("pinned Electrobun BrowserWindow partition patch", () => {
  it("uses the exact upstream source fixture", () => {
    expect(digest(upstream)).toBe(
      "8c172878fd77bd2119d7958a1c2c8280bf9642c78abf8a1cbcb67fa3b03226cf",
    );
  });

  it.each([false, true])(
    "preserves the Bun pointer variant (%s), partition, and idempotence",
    (widePointer) => {
      const input = widePointer
        ? upstream.replace("\tptr!: Pointer;", "\tptr!: Pointer | bigint;")
        : upstream;
      if (widePointer)
        expect(digest(input)).toBe(
          "f48dda33323ed599690ae25d663ea4dd6ce0d8c965d91b6893de58598c402e8c",
        );
      const patched = patchElectrobunBrowserWindowSource(input);
      expect(patched).toContain(
        widePointer ? "ptr!: Pointer | bigint;" : "ptr!: Pointer;",
      );
      expect(patched).toContain("\tpartition?: string | null;");
      expect(patched).toContain(
        "\t\tpartition,\n\t}: Partial<WindowOptionsType<T>>) {",
      );
      expect(patched).toContain("\t\t\tpartition: partition || null,");
      expect(patchElectrobunBrowserWindowSource(patched)).toBe(patched);
    },
  );

  it("rejects an unknown source and a corrupted already-patched source", () => {
    expect(() => patchElectrobunBrowserWindowSource(`${upstream}\n`)).toThrow(
      "unexpected BrowserWindow.ts",
    );
    expect(() =>
      patchElectrobunBrowserWindowSource(
        patchElectrobunBrowserWindowSource(upstream).replace(
          "partition || null",
          "null",
        ),
      ),
    ).toThrow("unexpected BrowserWindow.ts");
  });
});
