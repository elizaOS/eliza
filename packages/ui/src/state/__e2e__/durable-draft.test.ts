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
  isSendingDurableDraft,
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
const marked = (row: DurableDraft, sending?: boolean): DurableDraft =>
  sending ? { ...row, sending: true } : row;

/** An editor bound to an in-memory store that checks every write's receipt. */
function fixture() {
  let text = "";
  let saved: DurableDraft | null = null;
  const store: DurableDraftStore = {
    async read() {
      return saved;
    },
    async save(expected, value, _signal, write) {
      expect(expected).toEqual(saved);
      saved = marked(
        record(value, String(Number(saved?.revision ?? 0) + 1)),
        write?.sending,
      );
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
    async save(expected, value, _signal, write) {
      expect(expected).toEqual(saved);
      saved = marked(
        record(value, `${Number(saved?.revision ?? 0) + 1}`),
        write?.sending,
      );
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

  it("never offers the in-flight text for review when the conversation reopens with new typing", async () => {
    const f = fixture();
    f.external("In flight");
    await f.c.open("one");
    await f.c.hold("In flight");
    f.set("");
    await tick();
    f.c.retire();
    f.set("Typed meanwhile");
    await f.c.open("one");
    await tick();
    expect(f.c.state.conflict).toBe(false);
    expect(f.c.state.savedText).toBe("");
    expect(f.get()).toBe("Typed meanwhile");
    expect(f.saved()?.text).toBe("Typed meanwhile");
    expect(isSendingDurableDraft(f.saved())).toBe(false);
    await f.c.commit();
    expect(f.saved()?.text).toBe("Typed meanwhile");
    f.set("Typed meanwhile, more");
    await tick();
    expect(f.saved()?.text).toBe("Typed meanwhile, more");
  });

  it("returns an unsent in-flight message ahead of typing made in the reopened conversation", async () => {
    const f = fixture();
    f.external("In flight");
    await f.c.open("one");
    await f.c.hold("In flight");
    f.set("");
    await tick();
    f.c.retire();
    f.set("Later");
    await f.c.open("one");
    await tick();
    f.c.release();
    await tick();
    expect(f.get()).toBe("In flight\nLater");
    expect(f.saved()?.text).toBe("In flight\nLater");
  });

  it("keeps unsent text with its conversation, not in the editor, when the binding is retired before dispatch", async () => {
    const f = fixture();
    f.external("Unsent words");
    await f.c.open("one");
    await f.c.hold("Unsent words");
    f.set("");
    await tick();
    f.c.retire();
    f.set("");
    f.c.release();
    await tick();
    expect(f.get()).toBe("");
    expect(f.saved()?.text).toBe("Unsent words");
    expect(isSendingDurableDraft(f.saved())).toBe(false);
    expect(f.c.state.message).toBe(DEFAULT_DURABLE_DRAFT_MESSAGES.notSentKept);
    await f.c.open("one");
    expect(f.get()).toBe("Unsent words");
    expect(f.c.state.conflict).toBe(false);
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

/** One editor run (an app process, or a window) over a shared raw slot. */
function editorRun(slot: DurableDraftRawSlot) {
  let text = "";
  const c = new DurableDraftController(
    async (binding) => compareExchangeDraftStore(binding, slot),
    () => text,
    (value) => {
      text = value;
    },
    () => {},
  );
  return {
    c,
    get: () => text,
    set(value: string) {
      text = value;
      c.edit(value);
    },
  };
}
const savedRow = (slot: { raw: () => string | null }) =>
  JSON.parse(slot.raw() ?? "null") as DurableDraft | null;

describe("DurableDraftController sending across restarts and windows", () => {
  it("never moves a held message into another binding's editor or store when it is not dispatched", async () => {
    // One slot per binding (owner, agent and conversation identity).
    const slots = new Map<string, ReturnType<typeof rawSlot>>();
    const slotFor = (binding: string) => {
      let slot = slots.get(binding);
      if (!slot) slots.set(binding, (slot = rawSlot()));
      return slot;
    };
    let text = "";
    const c = new DurableDraftController(
      async (binding) => compareExchangeDraftStore(binding, slotFor(binding)),
      () => text,
      (value) => {
        text = value;
      },
      () => {},
    );
    const set = (value: string) => {
      text = value;
      c.edit(value);
    };
    await c.open("one");
    set("Meant for one");
    await c.hold("Meant for one");
    set("");
    await tick();
    await c.open("two");
    c.settle("not-dispatched");
    await tick();
    await tick();
    expect(text).toBe("");
    expect(c.state.message).toBe(DEFAULT_DURABLE_DRAFT_MESSAGES.notSentKept);
    expect(slotFor("two").raw()).toBeNull();
    // The next send from "two" cannot carry "one"'s text.
    await expect(c.hold("Meant for one")).rejects.toThrow();
    expect(slotFor("two").raw()).toBeNull();
    const one = savedRow(slotFor("one"));
    expect(one?.text).toBe("Meant for one");
    expect(isSendingDurableDraft(one)).toBe(false);
    await c.open("one");
    expect(text).toBe("Meant for one");
    expect(c.state.conflict).toBe(false);
    expect(c.state.unsettled).toBe(false);
  });

  it("does not let a release while retired leak into the next binding to open", async () => {
    const slots = new Map<string, ReturnType<typeof rawSlot>>();
    const slotFor = (binding: string) => {
      let slot = slots.get(binding);
      if (!slot) slots.set(binding, (slot = rawSlot()));
      return slot;
    };
    let text = "";
    const c = new DurableDraftController(
      async (binding) => compareExchangeDraftStore(binding, slotFor(binding)),
      () => text,
      (value) => {
        text = value;
      },
      () => {},
    );
    await c.open("owner-a");
    text = "Owner A's words";
    c.edit(text);
    await c.hold(text);
    text = "";
    c.retire();
    c.release();
    await c.open("owner-b");
    await tick();
    expect(text).toBe("");
    expect(slotFor("owner-b").raw()).toBeNull();
    expect(savedRow(slotFor("owner-a"))?.text).toBe("Owner A's words");
  });

  it("reports text over the size limit as too long, not as a conflict, and recovers once shortened", async () => {
    const slot = rawSlot();
    let text = "";
    const c = new DurableDraftController(
      async (binding) =>
        compareExchangeDraftStore(binding, slot, { textLimit: 16 }),
      () => text,
      (value) => {
        text = value;
      },
      () => {},
    );
    const set = (value: string) => {
      text = value;
      c.edit(value);
    };
    await c.open("test");
    set("Short");
    await tick();
    set("Far too long to be saved here");
    await tick();
    expect(c.state).toMatchObject({
      conflict: false,
      message: DEFAULT_DURABLE_DRAFT_MESSAGES.tooLarge,
    });
    expect(savedRow(slot)?.text).toBe("Short");
    await expect(c.hold("Far too long to be saved here")).rejects.toThrow(
      DEFAULT_DURABLE_DRAFT_MESSAGES.tooLarge,
    );
    expect(c.holding).toBe(false);
    expect(isSendingDurableDraft(savedRow(slot))).toBe(false);
    expect(text).toBe("Far too long to be saved here");
    set("Shorter");
    await tick();
    expect(c.state.message).toBe("");
    expect(savedRow(slot)?.text).toBe("Shorter");
    await c.hold("Shorter");
    expect(savedRow(slot)).toMatchObject({ text: "Shorter", sending: true });
  });

  it("marks the saved copy while a send is in flight; the commit clears it unmarked", async () => {
    const slot = rawSlot();
    const run = editorRun(slot);
    await run.c.open("test");
    run.set("Hello agent");
    await run.c.hold("Hello agent");
    expect(savedRow(slot)).toMatchObject({
      text: "Hello agent",
      sending: true,
    });
    run.set("");
    await run.c.commit();
    const cleared = savedRow(slot);
    expect(cleared?.text).toBe("");
    expect(isSendingDurableDraft(cleared)).toBe(false);
  });

  it("saves a released message unmarked, so a restart restores it as a draft", async () => {
    const slot = rawSlot();
    const run = editorRun(slot);
    await run.c.open("test");
    run.set("Refused before posting");
    await run.c.hold("Refused before posting");
    run.set("");
    run.c.release();
    await tick();
    expect(savedRow(slot)).not.toHaveProperty("sending");
    expect(savedRow(slot)?.text).toBe("Refused before posting");
    const restarted = editorRun(slot);
    await restarted.c.open("test");
    expect(restarted.get()).toBe("Refused before posting");
    expect(restarted.c.state.conflict).toBe(false);
  });

  it("never restores a message that was in flight when the app stopped; it is offered for review", async () => {
    const slot = rawSlot();
    const first = editorRun(slot);
    await first.c.open("test");
    first.set("Maybe delivered");
    await first.c.hold("Maybe delivered");
    first.set("");
    // The process dies before the send settles.
    const restarted = editorRun(slot);
    await restarted.c.open("test");
    expect(restarted.get()).toBe("");
    expect(restarted.c.state).toMatchObject({
      opening: false,
      conflict: true,
      unsettled: true,
      savedText: "Maybe delivered",
      message: DEFAULT_DURABLE_DRAFT_MESSAGES.unsettled,
    });
    // Nothing else can be sent from this draft until the person decides.
    restarted.set("Something new");
    await expect(restarted.c.hold("Something new")).rejects.toThrow(
      DEFAULT_DURABLE_DRAFT_MESSAGES.reviewUnsettled,
    );
    await tick();
    expect(savedRow(slot)).toMatchObject({
      text: "Maybe delivered",
      sending: true,
    });
  });

  it("keeps the mark when the page goes away with the send unsettled", async () => {
    const slot = rawSlot();
    const first = editorRun(slot);
    await first.c.open("test");
    first.set("Sent as the page closed");
    await first.c.hold("Sent as the page closed");
    first.set("");
    const writes = slot.writes();
    // Teardown fails the request; its outcome is shown to no one.
    first.c.abandon();
    expect(first.c.holding).toBe(false);
    await first.c.commit();
    first.c.release();
    await tick();
    expect(slot.writes()).toBe(writes);
    expect(first.get()).toBe("");
    expect(savedRow(slot)).toMatchObject({
      text: "Sent as the page closed",
      sending: true,
    });
    const restarted = editorRun(slot);
    await restarted.c.open("test");
    expect(restarted.get()).toBe("");
    expect(restarted.c.state).toMatchObject({
      conflict: true,
      unsettled: true,
      savedText: "Sent as the page closed",
    });
  });

  it("puts an unsettled message back on request as an ordinary draft", async () => {
    const slot = rawSlot();
    const first = editorRun(slot);
    await first.c.open("test");
    first.set("Check first");
    await first.c.hold("Check first");
    const restarted = editorRun(slot);
    await restarted.c.open("test");
    restarted.c.restoreSaved();
    expect(restarted.get()).toBe("Check first");
    expect(restarted.c.state).toMatchObject({
      conflict: false,
      unsettled: false,
      message: DEFAULT_DURABLE_DRAFT_MESSAGES.savedRestored,
    });
    await tick();
    expect(savedRow(slot)).not.toHaveProperty("sending");
    const again = editorRun(slot);
    await again.c.open("test");
    expect(again.get()).toBe("Check first");
    expect(again.c.state.conflict).toBe(false);
  });

  it("replaces an unsettled message with the editor's text when the person keeps it", async () => {
    const slot = rawSlot();
    const first = editorRun(slot);
    await first.c.open("test");
    first.set("Already delivered");
    await first.c.hold("Already delivered");
    const restarted = editorRun(slot);
    await restarted.c.open("test");
    restarted.c.keepCurrent();
    await tick();
    expect(savedRow(slot)?.text).toBe("");
    expect(savedRow(slot)).not.toHaveProperty("sending");
    expect(restarted.c.state.conflict).toBe(false);
    restarted.set("Next message");
    await restarted.c.hold("Next message");
    expect(savedRow(slot)).toMatchObject({
      text: "Next message",
      sending: true,
    });
  });

  it("offers the review when text typed before opening equals the unsettled message", async () => {
    const slot = rawSlot();
    const first = editorRun(slot);
    await first.c.open("test");
    first.set("Same words");
    await first.c.hold("Same words");
    const restarted = editorRun(slot);
    restarted.set("Same words");
    await restarted.c.open("test");
    expect(restarted.get()).toBe("Same words");
    expect(restarted.c.state).toMatchObject({
      conflict: true,
      unsettled: true,
    });
    restarted.c.keepCurrent();
    await tick();
    expect(savedRow(slot)).not.toHaveProperty("sending");
    expect(savedRow(slot)?.text).toBe("Same words");
  });

  it("never lets another window take over a message that is being sent", async () => {
    const slot = rawSlot();
    const sender = editorRun(slot);
    await sender.c.open("test");
    sender.set("From window A");
    await sender.c.hold("From window A");
    sender.set("");
    const other = editorRun(slot);
    await other.c.open("test");
    expect(other.get()).toBe("");
    expect(other.c.state.unsettled).toBe(true);
    await sender.c.commit();
    expect(savedRow(slot)?.text).toBe("");
    expect(other.get()).toBe("");
  });

  it("refuses the send when the mark cannot be written, keeping the text for review", async () => {
    const slot = rawSlot();
    const run = editorRun(slot);
    await run.c.open("test");
    run.set("Keep me");
    await tick();
    slot.set(JSON.stringify(record("Other window", "other")));
    await expect(run.c.hold("Keep me")).rejects.toThrow(
      /Review local draft storage/,
    );
    expect(run.c.holding).toBe(false);
    expect(run.get()).toBe("Keep me");
    expect(run.c.state).toMatchObject({
      conflict: true,
      unsettled: false,
      savedText: "Other window",
    });
    expect(savedRow(slot)?.text).toBe("Other window");
  });

  it("cancels the send when the editor changes while the mark is written", async () => {
    const slot = rawSlot();
    let pause: Promise<void> | undefined;
    let resume = () => {};
    const gated: DurableDraftRawSlot = {
      read: () => slot.read(),
      async compareExchange(expected, value) {
        if (pause) await pause;
        return slot.compareExchange(expected, value);
      },
    };
    const run = editorRun(gated);
    await run.c.open("test");
    run.set("Original");
    await tick();
    pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const holding = run.c.hold("Original");
    await tick();
    run.set("Original and more");
    pause = undefined;
    resume();
    await expect(holding).rejects.toThrow(/draft changed/);
    await tick();
    expect(run.c.holding).toBe(false);
    expect(savedRow(slot)?.text).toBe("Original and more");
    expect(savedRow(slot)).not.toHaveProperty("sending");
  });

  it("writes no mark for an empty editor", async () => {
    const slot = rawSlot();
    const run = editorRun(slot);
    await run.c.open("test");
    const writes = slot.writes();
    await run.c.hold("");
    expect(slot.writes()).toBe(writes);
    await run.c.commit();
    expect(run.c.holding).toBe(false);
  });

  it("still sends through a host store that drops the write option, without the mark", async () => {
    const slot = rawSlot();
    let text = "";
    const c = new DurableDraftController(
      async (binding) => {
        const store = compareExchangeDraftStore(binding, slot);
        return {
          ...store,
          save: (expected, value) => store.save(expected, value),
        };
      },
      () => text,
      (value) => {
        text = value;
      },
      () => {},
    );
    await c.open("test");
    text = "Plain store";
    c.edit(text);
    await c.hold("Plain store");
    expect(savedRow(slot)).not.toHaveProperty("sending");
    text = "";
    await c.commit();
    expect(savedRow(slot)?.text).toBe("");
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

  it("carry the sending mark only as `true`, and mark or unmark as a new revision", () => {
    const sending = { ...record("Out"), sending: true as const };
    expect(readDurableDraft(sending, "test")).toEqual(sending);
    expect(isSendingDurableDraft(sending)).toBe(true);
    expect(isSendingDurableDraft(record("Out"))).toBe(false);
    expect(isSendingDurableDraft(null)).toBe(false);
    for (const value of [
      { ...record("Out"), sending: false },
      { ...record("Out"), sending: "yes" },
      { ...record("Out"), sending: true, extra: true },
    ])
      expect(() => readDurableDraft(value, "test")).toThrow(
        DurableDraftInvalid,
      );
    let next = 0;
    const revision = () => `m${++next}`;
    const saved = record("Out");
    const markedRow = replaceDurableDraft(saved, saved, "test", "Out", {
      revision,
      sending: true,
    });
    expect(markedRow).toEqual({ ...record("Out", "m1"), sending: true });
    expect(
      replaceDurableDraft(markedRow, markedRow, "test", "Out", {
        sending: true,
      }),
    ).toBe(markedRow);
    const unmarked = replaceDurableDraft(markedRow, markedRow, "test", "Out", {
      revision,
    });
    expect(unmarked).toEqual(record("Out", "m2"));
    // A writer that saw the row before it was marked holds a stale receipt.
    expect(() =>
      replaceDurableDraft(markedRow, saved, "test", "Edited", { revision }),
    ).toThrow(DurableDraftConflict);
    expect(() =>
      replaceDurableDraft(
        markedRow,
        { ...markedRow, sending: undefined } as unknown as DurableDraft,
        "test",
        "Edited",
      ),
    ).toThrow(DurableDraftInvalid);
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

  it("writes and reads back the sending mark, and a plain write clears it", async () => {
    const slot = rawSlot();
    const store = compareExchangeDraftStore("test", slot);
    const first = await store.save(null, "Out");
    const sending = await store.save(first, "Out", undefined, {
      sending: true,
    });
    expect(JSON.parse(slot.raw() ?? "null")).toEqual(sending);
    expect(sending.sending).toBe(true);
    const read = compareExchangeDraftStore("test", slot);
    const restored = await read.read();
    expect(isSendingDurableDraft(restored)).toBe(true);
    const cleared = await read.save(restored, "");
    expect(JSON.parse(slot.raw() ?? "null")).toEqual(cleared);
    expect(cleared).not.toHaveProperty("sending");
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

  it("writes the sending mark and clears it with the next write", async () => {
    const doc = document();
    const store = transactionalDraftStore("test", doc);
    const sending = await store.save(null, "Out", undefined, {
      sending: true,
    });
    expect(doc.value()).toEqual(sending);
    expect(isSendingDurableDraft(await store.read())).toBe(true);
    const cleared = await store.save(sending, "");
    expect(doc.value()).toEqual(cleared);
    expect(isSendingDurableDraft(await store.read())).toBe(false);
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
