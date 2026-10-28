type Events = {
  open: undefined;
  message: { readonly data: unknown };
  error: { readonly message?: string; readonly error?: unknown };
  close: { readonly code?: number; readonly reason?: string };
};
/** Typed event wiring shared by the actual Sonic composition fixtures. */
export function cartesiaEvents() {
  const listeners: { [K in keyof Events]: Set<(event: Events[K]) => void> } = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };
  return {
    emit<K extends keyof Events>(type: K, value: Events[K]) {
      for (const listener of listeners[type]) listener(value);
    },
    addEventListener<K extends keyof Events>(
      type: K,
      listener: (event: Events[K]) => void,
    ) {
      listeners[type].add(listener);
    },
    removeEventListener<K extends keyof Events>(
      type: K,
      listener: (event: Events[K]) => void,
    ) {
      listeners[type].delete(listener);
    },
  };
}
