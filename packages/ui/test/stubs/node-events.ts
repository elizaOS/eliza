// Stub for `node:events` in the Storybook browser catalog. Provides a working
// minimal EventEmitter (used at load by core modules pulled via the
// @elizaos/shared barrel) so module init and any benign listener wiring work.
type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private listeners = new Map<string | symbol, Listener[]>();
  on(event: string | symbol, fn: Listener): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(fn);
    this.listeners.set(event, arr);
    return this;
  }
  addListener(event: string | symbol, fn: Listener): this {
    return this.on(event, fn);
  }
  once(event: string | symbol, fn: Listener): this {
    const wrap = (...args: unknown[]) => {
      this.off(event, wrap);
      fn(...args);
    };
    return this.on(event, wrap);
  }
  off(event: string | symbol, fn: Listener): this {
    const arr = this.listeners.get(event);
    if (arr)
      this.listeners.set(
        event,
        arr.filter((l) => l !== fn),
      );
    return this;
  }
  removeListener(event: string | symbol, fn: Listener): this {
    return this.off(event, fn);
  }
  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    const arr = this.listeners.get(event);
    if (!arr || arr.length === 0) return false;
    for (const l of [...arr]) l(...args);
    return true;
  }
  listenerCount(event: string | symbol): number {
    return this.listeners.get(event)?.length ?? 0;
  }
  setMaxListeners(): this {
    return this;
  }
}

export const once = (emitter: EventEmitter, event: string | symbol) =>
  new Promise<unknown[]>((res) => emitter.once(event, (...args) => res(args)));
export const on = () => {
  throw new Error("node:events.on async iterator unavailable in Storybook");
};
export const defaultMaxListeners = 10;

export default EventEmitter;
