/**
 * Contract tests for the shared document scan state: page admission and order, one operation at a
 * time, export snapshots, compare-and-set autosave and the explicit Keep of a captured page.
 */
import { describe, expect, it, vi } from "vitest";
import {
  admitScanDimensions,
  admitScanImage,
  createScanCapture,
  createScanDocument,
  SCAN_LIMITS,
  ScanDocumentError,
  type ScanDraftPort,
  scanExportRetryable,
} from "./scan-document";

type Image = { type: string; size: number; name: string };
const image = (name: string, size = 10, type = "image/jpeg"): Image => ({
  name,
  size,
  type,
});
const names = (doc: { pages(): readonly { image: Image }[] }) =>
  doc.pages().map((page) => page.image.name);
const MB = 1024 * 1024;

function memoryDrafts() {
  let stored:
    | { revision: string; pages: Image[]; textLayers?: (string | null)[] }
    | undefined;
  let next = 0;
  const port: ScanDraftPort<Image, string> = {
    save: vi.fn(async (pages, revision, _signal, layers) => {
      if (stored && stored.revision !== revision)
        throw new Error("A newer draft exists");
      stored = { revision: `r${++next}`, pages, textLayers: layers };
      return { revision: stored.revision };
    }),
    read: vi.fn(async () => stored),
    remove: vi.fn(async (revision) => {
      if (stored?.revision !== revision) throw new Error("Draft changed");
      stored = undefined;
    }),
  };
  return {
    port,
    get stored() {
      return stored;
    },
    set stored(value) {
      stored = value;
    },
  };
}

describe("page admission", () => {
  it("admits JPEG, PNG and WebP up to 16 MB", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"])
      expect(() => admitScanImage(image("a", 1, type))).not.toThrow();
    expect(() => admitScanImage(image("a", 1, "image/gif"))).toThrow(
      ScanDocumentError,
    );
    expect(() => admitScanImage(image("a", 0))).toThrow(ScanDocumentError);
    expect(() => admitScanImage(image("a", SCAN_LIMITS.pageBytes + 1))).toThrow(
      ScanDocumentError,
    );
    expect(() => admitScanImage(undefined)).toThrow(ScanDocumentError);
  });

  it("refuses empty and over-32-megapixel dimensions", () => {
    expect(() => admitScanDimensions(4000, 8000)).not.toThrow();
    expect(() => admitScanDimensions(0, 10)).toThrow(ScanDocumentError);
    expect(() => admitScanDimensions(8000, 4001)).toThrow(ScanDocumentError);
    expect(() => admitScanDimensions(Number.NaN, 1)).toThrow(ScanDocumentError);
  });

  it("bounds a document to 20 pages and 64 MB, counting a replacement once", () => {
    const doc = createScanDocument<Image>();
    for (let i = 0; i < SCAN_LIMITS.pages; i++) doc.put(image(`p${i}`));
    expect(doc.snapshot().controls.addPage).toBe(false);
    expect(() => doc.put(image("extra"))).toThrow(/20 pages/);
    // Replacing keeps the count and is allowed at the limit.
    doc.put(image("replaced"), 3);
    expect(names(doc)[3]).toBe("replaced");

    const big = createScanDocument<Image>();
    for (let i = 0; i < 4; i++) big.put(image(`b${i}`, 16 * MB));
    expect(() => big.put(image("over", 1))).toThrow(/64 MB/);
    expect(() => big.put(image("same", 16 * MB), 0)).not.toThrow();
    expect(() => big.put(image("more", 16 * MB + 1), 0)).toThrow();
  });
});

describe("page order and controls", () => {
  it("moves, replaces and removes pages and reports per-page controls", () => {
    const changed = vi.fn();
    const doc = createScanDocument<Image>({ first: image("a"), changed });
    doc.put(image("b"));
    doc.put(image("c"));
    doc.move(0, 1);
    expect(names(doc)).toEqual(["b", "a", "c"]);
    doc.move(0, -1);
    expect(names(doc)).toEqual(["b", "a", "c"]);
    const removed = doc.remove(1);
    expect(removed?.image.name).toBe("a");
    expect(names(doc)).toEqual(["b", "c"]);
    expect(() => doc.remove(5)).toThrow(ScanDocumentError);
    const { controls } = doc.snapshot();
    expect(controls.pages).toEqual([
      { earlier: false, later: true, edit: true },
      { earlier: true, later: false, edit: true },
    ]);
    expect(changed).toHaveBeenCalled();
    // Ids stay stable across reorders so hosts can key previews.
    const ids = doc.pages().map((page) => page.id);
    doc.move(1, -1);
    expect(doc.pages().map((page) => page.id)).toEqual([ids[1], ids[0]]);
  });

  it("runs one operation at a time and disables every control while busy", async () => {
    const doc = createScanDocument<Image>({ first: image("a") });
    let release!: () => void;
    const first = doc.run(
      () => new Promise<string>((resolve) => (release = () => resolve("done"))),
    );
    expect(doc.snapshot().busy).toBe(true);
    expect(doc.snapshot().controls.export).toBe(false);
    expect(doc.snapshot().controls.pages[0].edit).toBe(false);
    expect(await doc.run(async () => "second")).toBeUndefined();
    release();
    expect(await first).toBe("done");
    expect(doc.snapshot().busy).toBe(false);
  });
});

describe("export", () => {
  it("exports an immutable snapshot and ends editing only on a final answer", async () => {
    const doc = createScanDocument<Image>({ first: image("a") });
    doc.put(image("b"));
    let seen: string[] = [];
    const result = await doc.exportPages(async (pages) => {
      seen = pages.map((page) => page.name);
      return { status: "cancelled", message: "Cancelled" };
    });
    expect(result?.status).toBe("cancelled");
    expect(seen).toEqual(["a", "b"]);
    expect(doc.snapshot().exported).toBe(false);

    let during: Promise<void> | undefined;
    await doc.exportPages(async (pages) => {
      // A change requested while the export reads its snapshot does not reach it.
      during = Promise.resolve().then(() => {
        expect(() => doc.put(image("c"))).not.toThrow();
      });
      await during;
      seen = pages.map((page) => page.name);
      return { status: "exported", message: "Saved" };
    });
    expect(seen).toEqual(["a", "b"]);
    expect(doc.snapshot().exported).toBe(true);
    expect(doc.snapshot().controls.export).toBe(false);
    expect(() => doc.put(image("d"))).toThrow(ScanDocumentError);
    expect(
      await doc.exportPages(async () => ({ status: "exported", message: "" })),
    ).toBeUndefined();
  });

  it("treats an unconfirmed export as final and a plain failure as retryable", async () => {
    class Unconfirmed extends Error {}
    const doc = createScanDocument<Image>({ first: image("a") });
    await expect(
      doc.exportPages(
        async () => {
          throw new Error("no space");
        },
        (error) => error instanceof Unconfirmed,
      ),
    ).rejects.toThrow("no space");
    expect(doc.snapshot().exported).toBe(false);
    await expect(
      doc.exportPages(
        async () => {
          throw new Unconfirmed("lost");
        },
        (error) => error instanceof Unconfirmed,
      ),
    ).rejects.toThrow("lost");
    expect(doc.snapshot().exported).toBe(true);
    expect(scanExportRetryable("too-large")).toBe(true);
    expect(scanExportRetryable("exported")).toBe(false);
  });

  it("records a host-run export with the host's editable statuses", () => {
    const doc = createScanDocument<Image>({ first: image("a") });
    doc.exportFinished("reviewed");
    expect(doc.snapshot().exported).toBe(false);
    doc.exportFinished("failed", (status) =>
      ["cancelled", "reviewed"].includes(status),
    );
    expect(doc.snapshot().exported).toBe(true);
  });
});

describe("drafts", () => {
  it("autosaves every change compare-and-set and removes only its own draft after export", async () => {
    const drafts = memoryDrafts();
    const doc = createScanDocument<Image, string>({
      drafts: drafts.port,
      autosave: true,
    });
    doc.put(image("a"));
    doc.put(image("b"));
    doc.setTextLayers(["one", null]);
    await doc.settled();
    expect(drafts.port.save).toHaveBeenCalledTimes(3);
    expect(drafts.stored?.pages.map((page) => page.name)).toEqual(["a", "b"]);
    expect(drafts.stored?.textLayers).toEqual(["one", null]);
    expect(doc.snapshot()).toMatchObject({
      autoSaved: true,
      draftRevision: "r3",
    });
    await doc.exportPages(async () => ({ status: "exported", message: "" }));
    await vi.waitFor(() => expect(drafts.stored).toBeUndefined());
    expect(doc.snapshot().draftRevision).toBeUndefined();
  });

  it("never replaces a newer draft silently and reports the failure", async () => {
    const drafts = memoryDrafts();
    drafts.stored = { revision: "other", pages: [image("x")] };
    const autosaveFailed = vi.fn();
    const doc = createScanDocument<Image, string>({
      drafts: drafts.port,
      autosave: true,
      autosaveFailed,
    });
    doc.put(image("a"));
    await doc.settled();
    expect(autosaveFailed).toHaveBeenCalledOnce();
    expect(drafts.stored?.revision).toBe("other");
  });

  it("keeps a draft the person saved after export, loads with confirmation and deletes on request", async () => {
    const drafts = memoryDrafts();
    const doc = createScanDocument<Image, string>({ drafts: drafts.port });
    expect(await doc.loadDraft(() => true)).toBe("none");
    doc.put(image("a"));
    expect(await doc.saveDraft()).toBe(true);
    expect(doc.snapshot()).toMatchObject({
      autoSaved: false,
      draftRevision: "r1",
    });
    await doc.exportPages(async () => ({ status: "exported", message: "" }));
    await doc.settled();
    expect(drafts.stored?.revision).toBe("r1");

    const other = createScanDocument<Image, string>({
      first: image("z"),
      drafts: drafts.port,
    });
    expect(await other.loadDraft(() => false)).toBe("kept");
    expect(names(other)).toEqual(["z"]);
    expect(await other.loadDraft(() => true)).toBe("loaded");
    expect(names(other)).toEqual(["a"]);
    expect(await other.deleteDraft(() => false)).toBe(false);
    expect(await other.deleteDraft(() => true)).toBe(true);
    expect(drafts.stored).toBeUndefined();
    expect(other.snapshot().controls.deleteDraft).toBe(false);
  });

  it("offers no draft actions without a store", async () => {
    const doc = createScanDocument<Image>({ first: image("a") });
    expect(doc.snapshot().controls).toMatchObject({
      saveDraft: false,
      loadDraft: false,
      deleteDraft: false,
    });
    expect(await doc.saveDraft()).toBe(false);
  });

  it("closing aborts work and ignores late answers", async () => {
    const drafts = memoryDrafts();
    let resolveSave!: (value: { revision: string }) => void;
    drafts.port.save = vi.fn(
      () =>
        new Promise<{ revision: string }>((resolve) => (resolveSave = resolve)),
    );
    const doc = createScanDocument<Image, string>({
      drafts: drafts.port,
      autosave: true,
    });
    doc.put(image("a"));
    await Promise.resolve();
    const open = doc.close();
    expect(open.map((page) => page.image.name)).toEqual(["a"]);
    expect(doc.signal.aborted).toBe(true);
    resolveSave({ revision: "late" });
    await doc.settled();
    expect(doc.snapshot()).toMatchObject({ closed: true, pages: [] });
    expect(doc.snapshot().draftRevision).toBeUndefined();
    expect(doc.close()).toEqual([]);
  });
});

describe("captured page Keep", () => {
  it("keeps only an unsaved capture, under one identity until a definite failure", async () => {
    const ids: string[] = [];
    const answers = [
      { status: "unknown" as const, message: "lost" },
      { status: "failed" as const, message: "nothing kept" },
      { status: "saved" as const, id: "7" },
    ];
    const keep = vi.fn(async (_image: Image, operationId: string) => {
      ids.push(operationId);
      const answer = answers.shift();
      if (!answer) throw new Error("unexpected keep");
      return answer;
    });
    const capture = createScanCapture(image("page"), "unsaved", keep);
    expect(capture.canKeep).toBe(true);
    expect((await capture.keep())?.status).toBe("unknown");
    expect((await capture.keep())?.status).toBe("failed");
    expect((await capture.keep())?.status).toBe("saved");
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(capture.canKeep).toBe(false);
    expect(await capture.keep()).toBeUndefined();
    expect(keep).toHaveBeenCalledTimes(3);
  });

  it("offers no Keep for captured or chosen pages, and a thrown port is unknown", async () => {
    const keep = vi.fn(async () => {
      throw new Error("");
    });
    expect(createScanCapture(image("p"), "selected", keep).canKeep).toBe(false);
    expect(
      await createScanCapture(image("p"), "captured", keep).keep(),
    ).toBeUndefined();
    const capture = createScanCapture(image("p"), "unsaved", keep);
    const outcome = await capture.keep();
    expect(outcome?.status).toBe("unknown");
    expect(outcome && "message" in outcome && outcome.message).toMatch(
      /could not be confirmed/,
    );
    capture.close();
    expect(capture.closed).toBe(true);
    expect(capture.canKeep).toBe(false);
  });
});
