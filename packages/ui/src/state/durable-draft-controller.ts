/**
 * Editor lifecycle for one durable draft at a time (see ./durable-draft).
 *
 * The controller keeps whatever the person typed: it saves edits for the
 * active binding, restores the saved text when a binding opens, and never
 * overwrites either copy when they differ (both are offered for review).
 * Writes queued for a binding stay with that binding even after the editor
 * moves to another owner, agent or conversation.
 *
 * Sending is a two-phase protocol so a message is never lost and never sent
 * twice from the draft:
 *
 * 1. {@link DurableDraftController.hold} before dispatch: the saved copy must
 *    equal the editor exactly; it stays saved while the editor is cleared for
 *    the in-flight message, and reopening the same binding meanwhile never
 *    offers that text again.
 * 2. {@link DurableDraftController.release} when dispatch certainly did not
 *    happen: the text returns to the editor (newer typing is kept after it).
 *    {@link DurableDraftController.commit} when dispatch happened, or may
 *    have happened: only then is the saved copy cleared. An unknown outcome
 *    is therefore never re-offered for sending; the host reconciles it from
 *    history instead. {@link DurableDraftController.settle} maps an outcome
 *    to one of the two.
 *
 * {@link DurableDraftController.consume} is the single-step variant for
 * forms whose own save is the effect: it clears the saved copy only while
 * the editor still holds exactly the reviewed text.
 */

import type { DurableDraft, DurableDraftStore } from "./durable-draft";

/** Product copy for every state the controller publishes or throws. */
export interface DurableDraftMessages {
  /** The store could not be opened at all (host-reported). */
  openFailed: string;
  /** The saved draft could not be read after retries. */
  readFailed: string;
  /** Saved text and editor text differ; both are offered. */
  savedAvailable: string;
  /** A write was refused; the saved copy is offered for review. */
  saveConflict: string;
  /** A write failed and the saved copy could not be read either. */
  saveFailed: string;
  /** The saved copy replaced the editor text at the person's request. */
  savedRestored: string;
  /** Sending is refused until the draft storage is reviewed. */
  storageUnavailable: string;
  /** The editor no longer holds the text that was about to be sent. */
  changed: string;
  /** A held message was not dispatched and is back in the editor. */
  notSent: string;
  /** Text typed during a send was saved after the send cleared its copy. */
  savedLocally: string;
  /** The message was dispatched but its saved copy could not be cleared. */
  clearFailed: string;
  /** {@link DurableDraftController.consume} is clearing the saved copy. */
  preparing: string;
  /** {@link DurableDraftController.consume} found the editor changed. */
  changedNothingSent: string;
}

export const DEFAULT_DURABLE_DRAFT_MESSAGES: Readonly<DurableDraftMessages> =
  Object.freeze({
    openFailed:
      "Local draft could not be opened. Your current text is retained.",
    readFailed: "Local draft could not be read. Your current text is retained.",
    savedAvailable: "A saved draft is available. Review both copies.",
    saveConflict:
      "Draft was not saved. Review the saved copy before replacing it.",
    saveFailed: "Draft was not saved. Your current text is retained.",
    savedRestored: "Saved draft restored. Review before sending.",
    storageUnavailable: "Review local draft storage before sending.",
    changed: "The draft changed. Review it before sending.",
    notSent: "Not sent. Your message is back in the composer.",
    savedLocally: "Draft saved locally.",
    clearFailed:
      "Message sent, but its saved draft could not be cleared. Review it before sending again.",
    preparing: "Preparing draft to send…",
    changedNothingSent: "The draft changed. Nothing was sent.",
  });

export interface DurableDraftState {
  /** Status text for the editor; empty when there is nothing to say. */
  message: string;
  /** The binding's saved draft is still being read. */
  opening: boolean;
  /** Saved and editor text differ; `savedText` holds the saved copy. */
  conflict: boolean;
  savedText: string;
  /** {@link DurableDraftController.consume} is in progress. */
  consuming: boolean;
  /** Storage failed; the editor text is retained but not saved. */
  error: boolean;
}

/** How a held send ended, as far as the host can tell. */
export type DurableDraftSendOutcome =
  | "dispatched"
  | "not-dispatched"
  /** The request may have reached its recipient; never offered again. */
  | "unknown";

/**
 * Replace the editor's text. A host that applies the change asynchronously
 * (a queued UI update) returns a promise that settles once it is applied;
 * writes stay paused until then. When `expectedText` is given the host must
 * apply the change only if the editor still shows exactly that text, and
 * only while `current()` still returns true.
 */
export type DurableDraftRestore = (
  text: string,
  expectedText?: string,
  current?: () => boolean,
) => void | Promise<void>;

interface Binding<Recovery> {
  key: string;
  store?: DurableDraftStore<Recovery>;
  record: DurableDraft | null;
  /** The last editor text this binding has seen (saved or queued). */
  last: string;
  ready: boolean;
  failed: boolean;
  queue: Promise<void>;
}

/** A send in flight: the saved copy keeps its text until dispatch is known. */
interface Held<Recovery> {
  binding: Binding<Recovery>;
  text: string;
  /** The same conversation reopened while the send was in flight. */
  peer?: Binding<Recovery>;
}

const OPEN_RETRY_DELAYS_MS = [150, 600] as const;
const initialState = (): DurableDraftState => ({
  message: "",
  opening: true,
  conflict: false,
  savedText: "",
  consuming: false,
  error: false,
});
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DurableDraftController<Recovery = unknown> {
  private active?: Binding<Recovery>;
  private opening?: Promise<void>;
  private held?: Held<Recovery>;
  private readonly messages: DurableDraftMessages;
  state: DurableDraftState = initialState();

  /**
   * @param factory opens the store for one binding (owner, agent and
   *   conversation identity); it may be retried while opening.
   * @param text reads the editor's current text.
   * @param restore replaces the editor's text (see {@link DurableDraftRestore}).
   * @param changed called after every {@link state} change.
   */
  constructor(
    private readonly factory: (
      binding: string,
    ) => Promise<DurableDraftStore<Recovery>>,
    private readonly text: () => string,
    private readonly restore: DurableDraftRestore,
    private readonly changed: () => void,
    messages: Partial<DurableDraftMessages> = {},
  ) {
    this.messages = { ...DEFAULT_DURABLE_DRAFT_MESSAGES, ...messages };
  }

  private publish(patch: Partial<DurableDraftState>): void {
    this.state = { ...this.state, ...patch };
    this.changed();
  }

  /** The active binding, or undefined while none is open. */
  get binding(): string | undefined {
    return this.active?.key;
  }

  /** The active store's recovery port, for the host's recovery UI. */
  recovery(): Recovery | undefined {
    return this.active?.store?.recovery;
  }

  /** Detach from the active binding. Queued writes stay with their binding. */
  retire(notify = true): void {
    this.active = undefined;
    this.state = initialState();
    if (notify) this.changed();
  }

  /** The host could not determine a binding: keep the text, report it. */
  unavailable(): void {
    this.retire();
    this.publish({
      opening: false,
      conflict: false,
      consuming: false,
      error: true,
      message: this.messages.openFailed,
    });
  }

  /** Open `key`; repeated calls for the active key share the same read. */
  open(key: string): Promise<void> {
    if (this.active?.key === key) return this.opening ?? Promise.resolve();
    const opening = this.load(key);
    this.opening = opening;
    return opening;
  }

  private async load(key: string): Promise<void> {
    const initial = this.text();
    const binding: Binding<Recovery> = {
      key,
      record: null,
      last: initial,
      ready: false,
      failed: false,
      queue: Promise.resolve(),
    };
    this.active = binding;
    this.publish({
      opening: true,
      conflict: false,
      consuming: false,
      error: false,
      message: "",
    });
    try {
      // Opening only reads. A transient failure is retried quietly, never by
      // replaying a write, and a binding retired meanwhile restores nothing.
      for (let attempt = 0; ; attempt++) {
        try {
          binding.store = await this.factory(key);
          binding.record = await binding.store.read();
          break;
        } catch (error) {
          if (this.active !== binding) return;
          const delay = OPEN_RETRY_DELAYS_MS[attempt];
          if (delay === undefined) throw error;
          await wait(delay);
          if (this.active !== binding) return;
        }
      }
      if (this.active !== binding) return;
      if (this.text() !== initial || initial !== "") {
        // Text typed before (or while) the draft opened always wins the
        // editor; a different saved copy is offered for review instead.
        binding.ready = true;
        if (binding.record && binding.record.text !== this.text()) {
          this.offerBoth(binding, binding.record.text);
          return;
        }
        binding.last = binding.record?.text ?? "";
        this.publish({ opening: false, message: "" });
        this.edit(this.text());
        return;
      }
      // The in-flight message's text stays saved until dispatch settles; it is
      // never offered again in the meantime.
      const held = this.held;
      const sending =
        held?.binding.key === key && binding.record?.text === held.text;
      const restored = sending ? "" : (binding.record?.text ?? "");
      binding.last = restored;
      if (sending && held) held.peer = binding;
      // The UI may queue its update: keep writes paused until it applies, and
      // let it check the original text and binding again when it does.
      await this.restore(restored, initial, () => this.active === binding);
      if (this.active !== binding) return;
      binding.ready = true;
      const current = this.text();
      if (current === restored) {
        this.publish({ opening: false, message: "" });
        return;
      }
      if (!sending && binding.record && binding.record.text !== current) {
        this.offerBoth(binding, binding.record.text);
        return;
      }
      binding.last = restored;
      this.publish({ opening: false, message: "" });
      this.edit(current);
    } catch {
      if (this.active === binding) {
        binding.failed = true;
        this.publish({
          opening: false,
          conflict: false,
          error: true,
          message: this.messages.readFailed,
        });
      }
    }
  }

  private offerBoth(binding: Binding<Recovery>, savedText: string): void {
    binding.failed = true;
    this.publish({
      opening: false,
      conflict: true,
      savedText,
      message: this.messages.savedAvailable,
    });
  }

  /** Record the editor's text; saved in order for the active binding. */
  edit(text: string): void {
    const binding = this.active;
    if (!binding || text === binding.last) return;
    binding.last = text;
    if (
      !binding.ready ||
      binding.failed ||
      this.state.consuming ||
      this.held?.binding === binding
    )
      return;
    this.publish({ message: "" });
    binding.queue = binding.queue.then(async () => {
      if (binding.failed) return;
      try {
        binding.record = await this.requireStore(binding).save(
          binding.record,
          text,
        );
        if (this.active === binding && binding.last === text)
          this.publish({ message: "" });
      } catch {
        binding.failed = true;
        if (this.active === binding) await this.reviewConflict(binding);
      }
    });
  }

  private requireStore(
    binding: Binding<Recovery>,
  ): DurableDraftStore<Recovery> {
    if (!binding.store) throw new Error(this.messages.storageUnavailable);
    return binding.store;
  }

  private async reviewConflict(binding: Binding<Recovery>): Promise<void> {
    try {
      const latest = await this.requireStore(binding).read();
      if (this.active !== binding) return;
      binding.record = latest;
      this.publish({
        opening: false,
        conflict: true,
        error: false,
        savedText: latest?.text ?? "",
        message: this.messages.saveConflict,
      });
    } catch {
      if (this.active === binding)
        this.publish({
          opening: false,
          conflict: false,
          error: true,
          message: this.messages.saveFailed,
        });
    }
  }

  /** Resolve a conflict by putting the saved copy in the editor. */
  restoreSaved(): void {
    const binding = this.active;
    if (!binding?.ready || !this.state.conflict) return;
    binding.failed = false;
    binding.last = binding.record?.text ?? "";
    void this.restore(binding.last);
    this.publish({
      conflict: false,
      message: binding.last ? this.messages.savedRestored : "",
    });
  }

  /** Resolve a conflict by saving the editor's text over the saved copy. */
  keepCurrent(): void {
    const binding = this.active;
    if (!binding?.ready || !this.state.conflict) return;
    binding.failed = false;
    const text = this.text();
    binding.last = binding.record?.text ?? "";
    this.publish({ conflict: false, error: false, message: "" });
    this.edit(text);
  }

  /** Reopen the active binding after a storage failure. */
  async retry(): Promise<void> {
    const key = this.active?.key;
    if (!key) return;
    this.retire();
    await this.open(key);
  }

  /**
   * Before dispatch: require the saved copy to match the editor exactly, then
   * keep it saved while the editor is cleared for the in-flight message.
   * Follow with {@link commit}, {@link release} or {@link settle}.
   */
  async hold(
    expectedText: string,
    current: () => boolean = () => true,
  ): Promise<void> {
    const binding = this.active;
    if (!binding?.ready || binding.failed || this.state.consuming || this.held)
      throw new Error(this.messages.storageUnavailable);
    this.edit(this.text());
    await binding.queue;
    if (
      this.active !== binding ||
      binding.failed ||
      !current() ||
      this.text() !== expectedText
    )
      throw new Error(this.messages.changed);
    this.held = { binding, text: this.text() };
  }

  /** A send is held between {@link hold} and its settlement. */
  get holding(): boolean {
    return !!this.held;
  }

  /** Dispatch did not happen: put the text back; newer typing follows it. */
  release(): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    const binding =
      this.active === held.binding
        ? held.binding
        : this.active && this.active === held.peer
          ? held.peer
          : undefined;
    if (!binding) {
      // The editor moved to another binding before dispatch. The text stays
      // saved with its own conversation; an empty editor also gets it back so
      // unsent words are never only in storage.
      if (this.text().trim()) return;
      void this.restore(held.text);
      this.publish({ message: this.messages.notSent });
      return;
    }
    const now = this.text();
    const restored = now.trim() ? `${held.text}\n${now}` : held.text;
    // The saved copy was never cleared.
    binding.last = held.text;
    void this.restore(restored);
    if (!binding.failed) this.edit(restored);
    this.publish({ message: this.messages.notSent });
  }

  /** Dispatch happened, or may have: clear the saved copy of the sent text. */
  async commit(): Promise<void> {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    const binding = held.binding;
    if (!binding.ready || binding.failed) return;
    // Serialised with this binding's writes: typing that resumes as the reply
    // arrives is queued after the clear instead of racing it.
    const task = binding.queue.then(async () => {
      if (binding.failed) return;
      const remaining = this.active === binding ? this.text() : "";
      try {
        binding.record = await this.requireStore(binding).save(
          binding.record,
          remaining,
        );
        if (this.active === binding && this.text() === remaining) {
          binding.last = remaining;
          this.publish({
            message: remaining ? this.messages.savedLocally : "",
          });
        }
        // A binding reopened for the same conversation shares this receipt.
        const peer = held.peer;
        if (peer && this.active === peer && !peer.failed)
          peer.record = binding.record;
      } catch {
        binding.failed = true;
        if (this.active === binding)
          this.publish({
            opening: false,
            conflict: false,
            error: true,
            message: this.messages.clearFailed,
          });
      }
    });
    binding.queue = task;
    await task;
  }

  /**
   * Settle a held send. Only a certain non-dispatch returns the text; an
   * unknown outcome clears the saved copy like a dispatch, so the same
   * message is never offered for a second send.
   */
  settle(outcome: DurableDraftSendOutcome): Promise<void> {
    if (outcome === "not-dispatched") {
      this.release();
      return Promise.resolve();
    }
    return this.commit();
  }

  /**
   * Clear the saved copy for a form whose own save is the effect, only while
   * the editor still holds `expectedText` (compared trimmed).
   */
  async consume(
    expectedText: string,
    current: () => boolean = () => true,
  ): Promise<void> {
    const binding = this.active;
    if (!binding?.ready || binding.failed || this.state.consuming)
      throw new Error(this.messages.storageUnavailable);
    this.edit(this.text());
    await binding.queue;
    if (
      this.active !== binding ||
      binding.failed ||
      !current() ||
      this.text().trim() !== expectedText
    )
      throw new Error(this.messages.changed);
    const original = binding.record?.text ?? this.text();
    this.publish({ consuming: true, message: this.messages.preparing });
    try {
      const store = this.requireStore(binding);
      binding.record = await store.save(binding.record, "");
      if (
        this.active !== binding ||
        !current() ||
        this.text().trim() !== expectedText
      ) {
        // Undo only this clear. A newer edit wins if this receipt is stale.
        try {
          binding.record = await store.save(
            binding.record,
            this.active === binding ? this.text() : original,
          );
        } catch {
          // The conflict review below reads the saved copy.
        }
        throw new Error(this.messages.changedNothingSent);
      }
      binding.last = "";
      void this.restore("");
      this.publish({ consuming: false, message: "" });
    } catch (error) {
      if (this.active === binding) {
        binding.failed = true;
        this.publish({ consuming: false });
        await this.reviewConflict(binding);
      }
      throw error;
    }
  }
}
