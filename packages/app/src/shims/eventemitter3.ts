type EventName = string | symbol;
type Listener = (...args: unknown[]) => void;

interface ListenerEntry {
  context?: unknown;
  listener: Listener;
  once: boolean;
}

export class EventEmitter {
  private readonly events = new Map<EventName, ListenerEntry[]>();

  eventNames(): EventName[] {
    return [...this.events.keys()];
  }

  listeners(event: EventName): Listener[] {
    return (this.events.get(event) ?? []).map((entry) => entry.listener);
  }

  listenerCount(event: EventName): number {
    return this.events.get(event)?.length ?? 0;
  }

  emit(event: EventName, ...args: unknown[]): boolean {
    const entries = this.events.get(event);
    if (!entries?.length) return false;

    for (const entry of [...entries]) {
      if (entry.once) {
        this.removeListener(event, entry.listener, entry.context, true);
      }
      entry.listener.apply(entry.context ?? this, args);
    }

    return true;
  }

  on(event: EventName, listener: Listener, context?: unknown): this {
    return this.addListener(event, listener, context);
  }

  addListener(event: EventName, listener: Listener, context?: unknown): this {
    if (typeof listener !== "function") {
      throw new TypeError("The listener must be a function");
    }
    const entries = this.events.get(event) ?? [];
    entries.push({ context, listener, once: false });
    this.events.set(event, entries);
    return this;
  }

  once(event: EventName, listener: Listener, context?: unknown): this {
    if (typeof listener !== "function") {
      throw new TypeError("The listener must be a function");
    }
    const entries = this.events.get(event) ?? [];
    entries.push({ context, listener, once: true });
    this.events.set(event, entries);
    return this;
  }

  removeListener(
    event: EventName,
    listener?: Listener,
    context?: unknown,
    once?: boolean,
  ): this {
    if (!listener) {
      this.events.delete(event);
      return this;
    }

    const entries = this.events.get(event);
    if (!entries) return this;

    const nextEntries = entries.filter((entry) => {
      if (entry.listener !== listener) return true;
      if (context !== undefined && entry.context !== context) return true;
      if (once !== undefined && entry.once !== once) return true;
      return false;
    });

    if (nextEntries.length) {
      this.events.set(event, nextEntries);
    } else {
      this.events.delete(event);
    }

    return this;
  }

  off(
    event: EventName,
    listener?: Listener,
    context?: unknown,
    once?: boolean,
  ): this {
    return this.removeListener(event, listener, context, once);
  }

  removeAllListeners(event?: EventName): this {
    if (event === undefined) {
      this.events.clear();
    } else {
      this.events.delete(event);
    }
    return this;
  }
}

export default EventEmitter;
