/** Registers a host-named action journal bridge. Browsers have no journal and fail closed. */
import { registerPlugin, WebPlugin } from "@capacitor/core";
import type { ActionJournalPlugin } from "./definitions.ts";

export * from "./client.ts";
export * from "./definitions.ts";

class UnavailableActionJournal extends WebPlugin {
  private refuse(): Promise<never> {
    return Promise.reject(
      this.unavailable(
        "The action journal is available only in the native app.",
      ),
    );
  }
  reserve() {
    return this.refuse();
  }
  markApplying() {
    return this.refuse();
  }
  finish() {
    return this.refuse();
  }
  get() {
    return this.refuse();
  }
  list() {
    return this.refuse();
  }
}

/** `name` is the host subclass's `@CapacitorPlugin` name. */
export function registerActionJournal<
  T extends ActionJournalPlugin = ActionJournalPlugin,
>(name: string): T {
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name))
    throw new Error("Invalid action journal plugin name");
  return registerPlugin<T>(name, {
    web: () => new UnavailableActionJournal() as unknown as T,
  });
}
