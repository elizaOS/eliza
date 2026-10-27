/**
 * Durable draft controller and store contract. In-memory stores stand in for
 * the native secure slot and the browser document store; the controller,
 * row validation and compare-and-exchange adapters are the shipped code.
 */
import { describe, expect, it } from "vitest";
import {
  browserDocumentDraftSlot,
  compareExchangeDraftStore,
  type DurableDraft,
  DurableDraftConflict,
  DurableDraftInvalid,
  type DurableDraftRawSlot,
  type DurableDraftStore,
  DurableDraftTooLarge,
  emptyDurableDraft,
  rawSlotDraftRecovery,
  readDurableDraft,
  replaceDurableDraft,
  transactionalDraftStore,
} from "../durable-draft";
import {
  DEFAULT_DURABLE_DRAFT_MESSAGES,
  DurableDraftController,
} from "../durable-draft-controller";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const record = (text: string, revision = "1"): DurableDraft => ({
  version: 1,
  binding: "test",
  revision,
  text,
});

/** An editor bound to an in-memory store that checks every write's receipt. */
function fixture() {
  let text = "";
  let saved: DurableDraft | null = null;
  const store: DurableDraftStore = {
    async read() {
      return saved;
    },
    async save(expected, value) {
      expect(expected).toEqual(saved);
      saved = record(value, String(Number(saved?.revision ?? 0) + 1));
      return saved;
    },
  };
  const controller = new DurableDraftController(
    async () => store,
    () => text,
    (value) => {
      text = value;
    },
    () => {},
  );
  return {
    c: controller,
    store,
    set(value: string) {
      text = value;
      controller.edit(value);
    },
    get: () => text,
    saved: () => saved,
    external(value: string) {
      saved = record(value, "external");
    },
  };
}

/** The UI applies restores only when the test commits its queued update. */
function queuedRestoreFixture(savedText: string | null = null) {
  let text = "";
  let saved = savedText === null ? null : record(savedText);
  let commitRestore: (() => void) | undefined;
  const store: DurableDraftStore = {
    async read() {
      return saved;
    },
    async save(expected, value) {
      expect(expected).toEqual(saved);
      saved = record(value, `${Number(saved?.revision ?? 0) + 1}`);
      return saved;
    },
  };
  const c = new DurableDraftController(
    async () => store,
    () => text,
    (value, expected, current) =>
      new Promise<void>((resolve) => {
        commitRestore = () => {
          if (
            (!current || current()) &&
            (expected === undefined || text === expected)
          )
            text = value;
          resolve();
        };
      }),
    () => {},
  );
  return {
    c,
    get: () => text,
    saved: () => saved,
    type(value: string) {
      text = value;
      c.edit(value);
    },
    commit: () => commitRestore?.(),
  };
}

describe("DurableDraftController opening", () => {
  it("quietly retries a transient read without losing restored text", async () => {
    const f = fixture();
    f.external("Keep these words");
    const read = f.store.read;
    let attempts = 0;
    f.store.read = async () => {
      if (++attempts === 1) throw new Error("Storage opening");
      return read.call(f.store);
    };
    const opening = f.c.open("one");
    expect(f.c.state.message).toBe("");
    expect(f.c.state.opening).toBe(true);
    await opening;
    expect(attempts).toBe(2);
    expect(f.c.state.error).toBe(false);
    expect(f.get()).toBe("Keep these words");
    expect(f.c.binding).toBe("one");
  });

  it("never restores a retired binding after a storage-open retry", async () => {
    const f = fixture();
    let attempts = 0;
    f.store.read = async () => {
      attempts++;
      throw new Error("Unavailable");
    };
    const opening = f.c.open("old");
    await tick();
    f.c.retire();
    f.set("New words");
    await opening;
    expect(attempts).toBe(1);
    expect(f.get()).toBe("New words");
    expect(f.c.state.error).toBe(false);
  });

  it("makes repeated opens of the same binding share one read", async () => {
    const f = fixture();
    let finish: ((value: DurableDraft) => void) | undefined;
    f.store.read = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const first = f.c.open("one");
    let secondFinished = false;
    const second = f.c.open("one").then(() => {
      secondFinished = true;
    });
    await tick();
    expect(secondFinished).toBe(false);
    finish?.(record("Saved words"));
    await Promise.all([first, second]);
    expect(f.get()).toBe("Saved words");
    expect(f.c.state.opening).toBe(false);
  });

  it("keeps a persistent read failure actionable and refuses to send", async () => {
    const f = fixture();
    f.store.read = async () => {
      throw new Error("Unavailable");
    };
    f.set("Unsent words");
    await f.c.open("one");
    expect(f.get()).toBe("Unsent words");
    expect(f.saved()).toBeNull();
    expect(f.c.state.error).toBe(true);
    expect(f.c.state.message).toBe(DEFAULT_DURABLE_DRAFT_MESSAGES.readFailed);
    await expect(f.c.hold("Unsent words")).rejects.toThrow(
      /Review local draft storage/,
    );
  });

  it("reports an unavailable binding without touching the editor", () => {
    const f = fixture();
    f.set("Typed words");
    f.c.unavailable();
    expect(f.get()).toBe("Typed words");
    expect(f.c.state).toMatchObject({ error: true, opening: false });
    expect(f.c.binding).toBeUndefined();
  });

  it("offers both copies when text typed before opening differs from the saved draft", async () => {
    const f = fixture();
    f.external("Saved earlier");
    f.set("Typed while opening");
    await f.c.open("one");
    expect(f.get()).toBe("Typed while opening");
    expect(f.c.state).toMatchObject({
      conflict: true,
      savedText: "Saved earlier",
    });
    expect(f.saved()?.text).toBe("Saved earlier");
    f.c.keepCurrent();
    await tick();
    expect(f.saved()?.text).toBe("Typed while opening");
    expect(f.c.state.conflict).toBe(false);
  });

  it("restores the saved copy on request", async () => {
    const f = fixture();
    f.external("Saved earlier");
    f.set("Typed while opening");
    await f.c.open("one");
    f.c.restoreSaved();
    expect(f.get()).toBe("Saved earlier");
    expect(f.c.state).toMatchObject({
      conflict: false,
      message: DEFAULT_DURABLE_DRAFT_MESSAGES.savedRestored,
    });
  });

  it("reviews a refused write instead of overwriting another writer", async () => {
    const f = fixture();
    await f.c.open("one");
    f.external("Another window");
    f.set("Mine");
    await tick();
    await tick();
    expect(f.c.state).toMatchObject({
      conflict: true,
      savedText: "Another window",
      message: DEFAULT_DURABLE_DRAFT_MESSAGES.saveConflict,
    });
    expect(f.saved()?.text).toBe("Another window");
    expect(f.get()).toBe("Mine");
  });
});

describe("DurableDraftController sending", () => {
  it("keeps the saved text while a send is in flight and clears it only after dispatch", async () => {
    const f = fixture();
    f.external("Hello agent");
    await f.c.open("one");
    expect(f.get()).toBe("Hello agent");
    await f.c.hold("Hello agent");
    expect(f.c.holding).toBe(true);
    f.set("");
    await tick();
    expect(f.saved()?.text).toBe("Hello agent");
    await f.c.commit();
    expect(f.c.holding).toBe(false);
    expect(f.saved()?.text).toBe("");
    expect(f.get()).toBe("");
  });

  it("returns the text after a pre-dispatch failure and keeps it saved", async () => {
    const f = fixture();
    f.external("Not yet sent");
    await f.c.open("one");
    await f.c.hold("Not yet sent");
    f.set("");
    await tick();
    f.c.release();
    await tick();
    expect(f.get()).toBe("Not yet sent");
    expect(f.saved()?.text).toBe("Not yet sent");
    expect(f.c.state.message).toMatch(/back in the composer/);
  });

  it("keeps typing during the send after the restored text and after a commit", async () => {
    const f = fixture();
    f.external("First");
    await f.c.open("one");
    await f.c.hold("First");
    f.set("");
    f.set("Second");
    await tick();
    f.c.release();
    await tick();
    expect(f.get()).toBe("First\nSecond");
    expect(f.saved()?.text).toBe("First\nSecond");
    await f.c.hold("First\nSecond");
    f.set("");
    f.set("Third");
    await tick();
    await f.c.commit();
    await tick();
    expect(f.saved()?.text).toBe("Third");
    expect(f.get()).toBe("Third");
    expect(f.c.state.message).toBe(DEFAULT_DURABLE_DRAFT_MESSAGES.savedLocally);
  });

  it("refuses a changed draft and a second concurrent send", async () => {
    const f = fixture();
    f.external("Draft");
    await f.c.open("one");
    await expect(f.c.hold("Other text")).rejects.toThrow(/draft changed/);
    await expect(f.c.hold("Draft", () => false)).rejects.toThrow(
      /draft changed/,
    );
    await f.c.hold("Draft");
    await expect(f.c.hold("Draft")).rejects.toThrow(
      /Review local draft storage/,
    );
    f.c.release();
    expect(f.saved()?.text).toBe("Draft");
  });

  it("never offers the in-flight text again when the same conversation reopens", async () => {
    const f = fixture();
    f.external("In flight");
    await f.c.open("one");
    await f.c.hold("In flight");
    f.set("");
    await tick();
    f.c.retire();
    await f.c.open("one");
    expect(f.get()).toBe("");
    await f.c.commit();
    expect(f.saved()?.text).toBe("");
    f.set("Next message");
    await tick();
    expect(f.saved()?.text).toBe("Next message");
  });

  it("keeps unsent text with its conversation when the binding changes before dispatch", async () => {
    const f = fixture();
    f.external("Unsent words");
    await f.c.open("one");
    await f.c.hold("Unsent words");
    f.set("");
    await tick();
    f.c.retire();
    f.set("");
    f.c.release();
    expect(f.get()).toBe("Unsent words");
    expect(f.saved()?.text).toBe("Unsent words");
    expect(f.c.state.message).toMatch(/back in the composer/);
  });

  it("queues typing as the reply arrives after the commit instead of racing it", async () => {
    const f = fixture();
    f.external("Sent text");
    await f.c.open("one");
    await f.c.hold("Sent text");
    f.set("");
    await tick();
    const committing = f.c.commit();
    f.set("Typed during commit");
    await committing;
    await tick();
    await tick();
    expect(f.c.state.conflict).toBe(false);
    expect(f.c.state.error).toBe(false);
    expect(f.saved()?.text).toBe("Typed during commit");
    expect(f.get()).toBe("Typed during commit");
  });

  it("binds exact authored whitespace and preserves it through a failed dispatch", async () => {
    const f = fixture();
    const authored = "  Indented.\n\nTrailing.  \n";
    f.external(authored);
    await f.c.open("one");
    await expect(f.c.hold(authored.trim())).rejects.toThrow(/draft changed/);
    await f.c.hold(authored);
    f.set("");
    await tick();
    f.c.release();
    await tick();
    expect(f.get()).toBe(authored);
    expect(f.saved()?.text).toBe(authored);
  });

  it("settles an unknown outcome like a dispatch: the text is never offered again", async () => {
    const f = fixture();
    f.external("Maybe delivered");
    await f.c.open("one");
    await f.c.hold("Maybe delivered");
    f.set("");
    await f.c.settle("unknown");
    expect(f.saved()?.text).toBe("");
    expect(f.get()).toBe("");
    await f.c.retry();
    expect(f.get()).toBe("");
  });

  it("settles a certain non-dispatch by returning the text", async () => {
    const f = fixture();
    f.external("Refused before posting");
    await f.c.open("one");
    await f.c.hold("Refused before posting");
    f.set("");
    await f.c.settle("not-dispatched");
    expect(f.get()).toBe("Refused before posting");
    expect(f.saved()?.text).toBe("Refused before posting");
  });

  it("reports a dispatched message whose saved copy could not be cleared", async () => {
    const f = fixture();
    f.external("Sent once");
    await f.c.open("one");
    await f.c.hold("Sent once");
    f.set("");
    f.external("Changed elsewhere");
    await f.c.commit();
    expect(f.c.state).toMatchObject({
      error: true,
      message: DEFAULT_DURABLE_DRAFT_MESSAGES.clearFailed,
    });
    await expect(f.c.hold("")).rejects.toThrow(/Review local draft storage/);
  });

  it("uses host copy for every published message", async () => {
    let text = "";
    const c = new DurableDraftController(
      async () => ({
        async read() {
          throw new Error("Unavailable");
        },
        async save() {
          throw new Error("Unavailable");
        },
      }),
      () => text,
      (value) => {
        text = value;
      },
      () => {},
      { readFailed: "Retained edits could not be read." },
    );
    await c.open("one");
    expect(c.state.message).toBe("Retained edits could not be read.");
    expect(DEFAULT_DURABLE_DRAFT_MESSAGES.readFailed).not.toBe(c.state.message);
  });
});

describe("DurableDraftController queued UI restores", () => {
  it("cannot clear newer unsent typing when the restore commits", async () => {
    const f = queuedRestoreFixture();
    const opening = f.c.open("one");
    await tick();
    f.type("Retained unsent draft");
    f.commit();
    await opening;
    await tick();
    expect(f.get()).toBe("Retained unsent draft");
    expect(f.saved()?.text).toBe("Retained unsent draft");
  });

  it("cannot overwrite a retired binding", async () => {
    const f = queuedRestoreFixture("Old conversation draft");
    const opening = f.c.open("old");
    await tick();
    f.c.retire();
    f.type("New conversation words");
    f.commit();
    await opening;
    expect(f.get()).toBe("New conversation words");
  });

  it("preserves both the saved text and newer typing for review", async () => {
    const f = queuedRestoreFixture("Previously saved draft");
    const opening = f.c.open("one");
    await tick();
    f.type("New unsent words");
    f.commit();
    await opening;
    await tick();
    expect(f.get()).toBe("New unsent words");
    expect(f.saved()?.text).toBe("Previously saved draft");
    expect(f.c.state.conflict).toBe(true);
    expect(f.c.state.savedText).toBe("Previously saved draft");
  });
});

describe("DurableDraftController consume", () => {
  it("clears the saved copy only for the reviewed text", async () => {
    const f = fixture();
    f.external("Reviewed form");
    await f.c.open("one");
    await f.c.consume("Reviewed form");
    expect(f.saved()?.text).toBe("");
    expect(f.get()).toBe("");
    expect(f.c.state.consuming).toBe(false);
  });

  it("restores the saved copy when the editor changes during the clear", async () => {
    const f = fixture();
    f.external("Reviewed form");
    await f.c.open("one");
    let stillCurrent = true;
    const save = f.store.save;
    f.store.save = async (expected, value) => {
      const result = await save.call(f.store, expected, value);
      stillCurrent = false;
      return result;
    };
    await expect(
      f.c.consume("Reviewed form", () => stillCurrent),
    ).rejects.toThrow(/Nothing was sent/);
    expect(f.saved()?.text).toBe("Reviewed form");
    expect(f.get()).toBe("Reviewed form");
  });
});

describe("durable draft rows", () => {
  it("validate exactly one binding's version-1 row", () => {
    expect(readDurableDraft(null, "test")).toBeNull();
    expect(readDurableDraft(record("Hello"), "test")).toEqual(record("Hello"));
    for (const value of [
      { ...record("Hello"), binding: "other" },
      { ...record("Hello"), version: 2 },
      { ...record("Hello"), extra: true },
      { ...record("Hello"), revision: "" },
      [],
      "text",
    ])
      expect(() => readDurableDraft(value, "test")).toThrow(
        DurableDraftInvalid,
      );
    expect(() => readDurableDraft(record("x".repeat(65)), "test", 64)).toThrow(
      DurableDraftInvalid,
    );
  });

  it("refuse a stale receipt, including an old empty one after a clear", () => {
    let next = 0;
    const revision = () => `r${++next}`;
    const first = replaceDurableDraft(null, null, "test", "Draft", {
      revision,
    });
    const cleared = replaceDurableDraft(first, first, "test", "", {
      revision,
    });
    expect(cleared).toEqual({ ...record("", "r2") });
    expect(() =>
      replaceDurableDraft(cleared, null, "test", "Stale", { revision }),
    ).toThrow(DurableDraftConflict);
    expect(() =>
      replaceDurableDraft(cleared, first, "test", "Stale", { revision }),
    ).toThrow(DurableDraftConflict);
    expect(replaceDurableDraft(cleared, cleared, "test", "")).toBe(cleared);
    expect(() =>
      replaceDurableDraft(null, null, "test", "x".repeat(65), {
        textLimit: 64,
      }),
    ).toThrow(DurableDraftTooLarge);
  });
});

/** A native-style secure slot: compares exact bytes. */
function rawSlot(initial: string | null = null) {
  let raw = initial;
  let writes = 0;
  const slot: DurableDraftRawSlot & {
    raw: () => string | null;
    writes: () => number;
    set: (value: string | null) => void;
  } = {
    async read() {
      return raw;
    },
    async compareExchange(expected, value) {
      writes++;
      if (raw !== expected) return { status: "conflict" };
      raw = value;
      return { status: "saved" };
    },
    raw: () => raw,
    writes: () => writes,
    set(value) {
      raw = value;
    },
  };
  return slot;
}

describe("compareExchangeDraftStore", () => {
  it("compares the exact bytes it read, not a re-serialisation", async () => {
    const original = `{ "text": "Spaced", "version": 1, "binding": "test", "revision": "a" }`;
    const slot = rawSlot(original);
    const store = compareExchangeDraftStore("test", slot);
    const saved = await store.read();
    expect(saved?.text).toBe("Spaced");
    const next = await store.save(saved, "Edited");
    expect(JSON.parse(slot.raw() ?? "null")).toEqual(next);
    expect(next.text).toBe("Edited");
  });

  it("refuses a competing write and an unreadable draft", async () => {
    const slot = rawSlot();
    const store = compareExchangeDraftStore("test", slot);
    const first = await store.save(null, "Window A");
    await expect(store.save(null, "Window B")).rejects.toThrow(
      DurableDraftConflict,
    );
    expect(JSON.parse(slot.raw() ?? "null")).toEqual(first);
    slot.set("{not json");
    await expect(store.read()).rejects.toThrow();
    slot.set(JSON.stringify({ ...record("Other"), binding: "other" }));
    await expect(store.read()).rejects.toThrow(DurableDraftInvalid);
  });

  it("refuses an aborted save before writing", async () => {
    const slot = rawSlot();
    const store = compareExchangeDraftStore("test", slot);
    const first = await store.save(null, "Keep");
    const cancel = new AbortController();
    cancel.abort();
    await expect(store.save(first, "Lost", cancel.signal)).rejects.toThrow();
    expect(slot.writes()).toBe(1);
    expect((await store.read())?.text).toBe("Keep");
  });

  it("exposes the host recovery port unchanged", () => {
    const recovery = { kind: "host" };
    expect(
      compareExchangeDraftStore("test", rawSlot(), { recovery }).recovery,
    ).toBe(recovery);
  });
});

describe("transactionalDraftStore", () => {
  function document(initial: unknown = null) {
    let value = initial;
    let edits = 0;
    return {
      async readJson() {
        return structuredClone(value);
      },
      async editJson(update: (actual: unknown) => unknown) {
        edits++;
        value = structuredClone(update(structuredClone(value)));
      },
      value: () => value,
      edits: () => edits,
    };
  }

  it("writes only when the expected row is still saved", async () => {
    const doc = document();
    const store = transactionalDraftStore("test", doc);
    const first = await store.save(null, "Draft");
    expect(doc.value()).toEqual(first);
    await expect(store.save(null, "Stale")).rejects.toThrow(
      DurableDraftConflict,
    );
    expect(doc.value()).toEqual(first);
    const cleared = await store.save(first, "");
    expect(cleared.text).toBe("");
    await expect(store.save(null, "Stale")).rejects.toThrow(
      DurableDraftConflict,
    );
    expect((await store.read())?.text).toBe("");
  });

  it("refuses an aborted save without editing", async () => {
    const doc = document();
    const store = transactionalDraftStore("test", doc);
    const cancel = new AbortController();
    cancel.abort();
    await expect(store.save(null, "Lost", cancel.signal)).rejects.toThrow();
    expect(doc.edits()).toBe(0);
    expect(doc.value()).toBeNull();
  });
});

describe("rawSlotDraftRecovery", () => {
  const damaged = ' { "version": 17, "text": "Keep this draft" }\n';

  it("captures exact bytes and resets them once, to an empty row", async () => {
    const slot = rawSlot(damaged);
    const recovery = rawSlotDraftRecovery("test", slot);
    const captured = await recovery.capture();
    expect(captured.raw).toBe(damaged);
    // The host UI replaces `raw` with its backup wrapper; only the receipt binds.
    const wrapped = { ...captured, raw: "UI backup wrapper" };
    await recovery.reset(wrapped);
    expect(JSON.parse(slot.raw() ?? "null")).toMatchObject({
      version: 1,
      binding: "test",
      text: "",
    });
    await expect(recovery.reset(captured)).rejects.toThrow(/Read the saved/);
    expect(slot.writes()).toBe(1);
  });

  it("refuses a reset after a competing write", async () => {
    const slot = rawSlot(damaged);
    const recovery = rawSlotDraftRecovery("test", slot);
    const captured = await recovery.capture();
    slot.set("newer draft");
    await expect(recovery.reset(captured)).rejects.toThrow(/changed/);
    expect(slot.raw()).toBe("newer draft");
  });

  it("never resets on an aborted signal, an unknown capture or an unreadable slot", async () => {
    const slot = rawSlot(damaged);
    const recovery = rawSlotDraftRecovery("test", slot);
    const captured = await recovery.capture();
    const cancel = new AbortController();
    cancel.abort();
    await expect(recovery.reset(captured, cancel.signal)).rejects.toThrow();
    await expect(
      recovery.reset({ snapshot: { revision: "forged", raw: damaged } }),
    ).rejects.toThrow(/Read the saved/);
    const unreadable = rawSlotDraftRecovery("test", {
      async read() {
        throw new Error("Secure storage read failed");
      },
      compareExchange: slot.compareExchange,
    });
    await expect(unreadable.capture()).rejects.toThrow(/read failed/);
    expect(slot.writes()).toBe(0);
    expect(slot.raw()).toBe(damaged);
  });

  it("writes the same empty row a cleared draft has", () => {
    expect(emptyDurableDraft("test", () => "r")).toEqual(record("", "r"));
  });
});

describe("browserDocumentDraftSlot", () => {
  /** The BrowserDocumentStore receipt contract, in memory. */
  function documents() {
    const rows = new Map<string, { revision: string; raw: string | null }>();
    let revision = 0;
    return {
      rows,
      async read(key: string) {
        return rows.get(key);
      },
      async compareExchange(
        key: string,
        expected: { revision: string; raw: string | null } | undefined,
        raw: string | null,
      ) {
        const current = rows.get(key);
        if (
          current?.revision !== expected?.revision ||
          current?.raw !== expected?.raw
        ) {
          const error = new Error("changed");
          error.name = "BrowserDocumentConflict";
          throw error;
        }
        const next = { revision: `r${++revision}`, raw };
        rows.set(key, next);
        return next;
      },
    };
  }

  it("lets a draft store save, clear and refuse stale receipts across windows", async () => {
    const docs = documents();
    const windowA = compareExchangeDraftStore(
      "test",
      browserDocumentDraftSlot(docs, "draft"),
    );
    const windowB = compareExchangeDraftStore(
      "test",
      browserDocumentDraftSlot(docs, "draft"),
    );
    const results = await Promise.allSettled([
      windowA.save(null, "Window A"),
      windowB.save(null, "Window B"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const saved = await windowA.read();
    expect(["Window A", "Window B"]).toContain(saved?.text);
    const cleared = await windowA.save(saved, "");
    expect(cleared.text).toBe("");
    await expect(windowB.save(null, "Stale")).rejects.toThrow(
      DurableDraftConflict,
    );
  });

  it("treats a reset tombstone as no draft", async () => {
    const docs = documents();
    docs.rows.set("draft", { revision: "tombstone", raw: null });
    const store = compareExchangeDraftStore(
      "test",
      browserDocumentDraftSlot(docs, "draft"),
    );
    expect(await store.read()).toBeNull();
    expect((await store.save(null, "After reset")).text).toBe("After reset");
  });
});
