/** Exercises native result validation before complete content reaches browser tools; transport payloads are controlled fixtures. */
import { describe, expect, it } from "vitest";
import { readNativeBrowserPage } from "./native-page-reader";

describe("complete native browser context", () => {
  it.each(["snapshot", "get"] as const)(
    "preserves a long %s through the tool boundary",
    async (subaction) => {
      const text = "visible complete text ".repeat(4000) + "最後 Ω";
      const result = await readNativeBrowserPage(
        { subaction },
        "requesting-client",
        async () => ({
          url: "https://example.test/",
          title: "Page",
          text,
          truncated: false,
        }),
      );
      expect(
        subaction === "snapshot"
          ? (result.value as { bodyText: string }).bodyText
          : result.value,
      ).toBe(text);
    },
  );
  it.each(["snapshot", "get"] as const)(
    "rejects clipped %s before returning a model payload",
    async (subaction) => {
      await expect(
        readNativeBrowserPage({ subaction }, "requesting-client", async () => ({
          url: "https://example.test/",
          title: "Page",
          text: "clipped prefix",
          truncated: true,
        })),
      ).rejects.toMatchObject({ code: "NATIVE_PAGE_READ_INCOMPLETE" });
    },
  );
});

describe("native command receipts", () => {
  it("preserves complete accessibility snapshots and snapshot-bound selectors", async () => {
    const { decodeNativeBrowserCommandResult } = await import(
      "./native-page-reader"
    );
    const data = {
      representation: "android-accessibility",
      packageName: "org.chromium.chrome",
      snapshotId: "current",
      complete: true,
      elements: [
        { selector: "current:ax-0", label: "complete ".repeat(10000) },
      ],
    };
    expect(
      decodeNativeBrowserCommandResult(
        { subaction: "snapshot" },
        { ok: true, data },
      ).value,
    ).toEqual(data);
  });
  it("rejects incomplete page reads and false effect completion", async () => {
    const { decodeNativeBrowserCommandResult } = await import(
      "./native-page-reader"
    );
    expect(() =>
      decodeNativeBrowserCommandResult(
        { subaction: "snapshot" },
        {
          ok: true,
          data: {
            url: "https://example.com",
            title: "Page",
            text: "prefix",
            truncated: true,
          },
        },
      ),
    ).toThrow(/incomplete/);
    expect(() =>
      decodeNativeBrowserCommandResult(
        { subaction: "click" },
        { ok: true, data: { dispatched: true, completed: true } },
      ),
    ).toThrow(/receipt/);
  });
  it("preserves native stale reference failures without claiming an effect", async () => {
    const { decodeNativeBrowserCommandResult } = await import(
      "./native-page-reader"
    );
    expect(() =>
      decodeNativeBrowserCommandResult(
        { subaction: "click" },
        { ok: false, code: "STALE_REF", message: "Refresh the snapshot." },
      ),
    ).toThrow(
      expect.objectContaining({ kind: "STALE_REF", targetId: "native-client" }),
    );
  });
});
