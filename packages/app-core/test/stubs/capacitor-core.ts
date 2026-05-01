type ListenerHandle = {
  remove(): Promise<void>;
};

export type PluginListenerHandle = ListenerHandle;

export class WebPlugin {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  notifyListeners(eventName: string, data: unknown): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(data);
    }
  }

  addListener(
    eventName: string,
    listenerFunc: (data: unknown) => void,
  ): Promise<ListenerHandle> {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listenerFunc);
    this.listeners.set(eventName, listeners);

    return Promise.resolve({
      remove: async () => {
        listeners.delete(listenerFunc);
      },
    });
  }

  removeAllListeners(): Promise<void> {
    this.listeners.clear();
    return Promise.resolve();
  }
}

export const Capacitor: {
  Plugins?: Record<string, unknown>;
  getPlatform(): string;
  isNativePlatform(): boolean;
  isPluginAvailable(name: string): boolean;
} = {
  Plugins: {},
  getPlatform: () => "web",
  isNativePlatform: () => false,
  isPluginAvailable: (name) => Boolean(Capacitor.Plugins?.[name]),
};

export function registerPlugin<T extends object>(name: string): T {
  const plugin = (Capacitor.Plugins?.[name] ?? {}) as T;
  Capacitor.Plugins = {
    ...(Capacitor.Plugins ?? {}),
    [name]: plugin,
  };
  return plugin;
}
