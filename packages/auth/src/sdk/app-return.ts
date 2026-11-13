/** A foreground signal requests a canonical read; it never proves an OAuth grant. */
export type AccountReturnBinding = Readonly<{
  client?: object;
  environment: string;
  userId: string;
  organizationId: string;
  sessionId: string;
  credentialId: string;
}>;
export function sameAccountReturnBinding(
  a: AccountReturnBinding | null,
  b: AccountReturnBinding | null,
): boolean {
  return (
    !!a &&
    !!b &&
    a.client === b.client &&
    a.environment === b.environment &&
    a.userId === b.userId &&
    a.organizationId === b.organizationId &&
    a.sessionId === b.sessionId &&
    a.credentialId === b.credentialId
  );
}
type Listener = { remove(): Promise<void> | void };
export function watchForegroundAccountReturn(options: {
  binding: AccountReturnBinding;
  current: () => AccountReturnBinding | null;
  foreground: () => boolean;
  refresh: () => void;
  onVisibilityChange: (listener: () => void) => () => void;
  onFocus: (listener: () => void) => () => void;
  onNativeResume?: (listener: () => void) => Promise<Listener>;
}) {
  let closed = false,
    pending: { backgrounded: boolean } | undefined,
    native: Listener | undefined;
  const current = () =>
    !closed && sameAccountReturnBinding(options.binding, options.current());
  const returned = () => {
    if (!current()) {
      pending = undefined;
      return;
    }
    if (!pending?.backgrounded || !options.foreground()) return;
    pending = undefined; // Consume before scheduling the existing load; duplicate events are inert.
    options.refresh();
  };
  const visibility = () => {
    if (!current()) {
      pending = undefined;
      return;
    }
    if (!options.foreground()) {
      if (pending) pending.backgrounded = true;
    } else returned();
  };
  const removeVisibility = options.onVisibilityChange(visibility),
    removeFocus = options.onFocus(returned);
  // Native appResumed is retained. Registration resolution does NOT mean its
  // cached callback drained; only an independently observed background can arm return.
  const ready = options.onNativeResume
    ? options.onNativeResume(returned).then(
        (handle) => {
          if (closed) void Promise.resolve(handle.remove()).catch(() => {});
          else native = handle;
        },
        () => {},
      )
    : Promise.resolve();
  return {
    ready,
    isCurrent: current,
    arm() {
      if (!current() || !options.foreground())
        throw new DOMException("The account connection changed.", "AbortError");
      const attempt = { backgrounded: false };
      pending = attempt;
      return () => {
        if (pending === attempt) pending = undefined;
      };
    },
    close() {
      if (closed) return;
      closed = true;
      pending = undefined;
      removeVisibility();
      removeFocus();
      if (native) void Promise.resolve(native.remove()).catch(() => {});
    },
  };
}

export interface WorkspaceAppReturnPort {
  prepare(
    binding: AccountReturnBinding,
  ): Promise<{ supported: boolean; redirectUrl?: string; state?: string }>;
  consume(binding: AccountReturnBinding): Promise<{
    result: "none" | "connected" | "denied" | "failed";
    connectionId?: string;
  }>;
  cancel(state: string): Promise<void>;
  subscribe(listener: () => void): Promise<{ remove(): void | Promise<void> }>;
}

/** Product configuration for the registered Workspace AppReturn v2 callback. */
export interface WorkspaceAppReturnConfig {
  readonly callbackUrl: string;
  readonly pluginName: string;
  readonly methods: readonly string[];
}
/** Callback and bridge identifiers are host inputs. No credential or provider grant is accepted here. */
export function createWorkspaceAppReturn(input: WorkspaceAppReturnConfig) {
  const url = new URL(input.callbackUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.href !== input.callbackUrl ||
    !input.pluginName ||
    input.methods.length !== 3 ||
    new Set(input.methods).size !== 3 ||
    input.methods.some((name) => !name)
  )
    throw new Error("Invalid Workspace app return configuration");
  const config = Object.freeze({
    ...input,
    methods: Object.freeze([...input.methods]),
  });
  function redirectAllowed(value: string): boolean {
    try {
      const url = new URL(value),
        keys = [...url.searchParams.keys()];
      return (
        value ===
          `${config.callbackUrl}?state=${url.searchParams.get("state")}` &&
        keys.length === 1 &&
        keys[0] === "state" &&
        /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "")
      );
    } catch {
      return false;
    }
  }
  async function prepare(
    port: WorkspaceAppReturnPort | undefined,
    binding: AccountReturnBinding,
    current: () => AccountReturnBinding | null,
  ) {
    if (!port || binding.environment !== "production") return undefined;
    if (!sameAccountReturnBinding(binding, current()))
      throw new DOMException("Workspace connection changed", "AbortError");
    const offer = await port.prepare(binding);
    if (!sameAccountReturnBinding(binding, current())) {
      if (offer.state) await port.cancel(offer.state);
      throw new DOMException("Workspace connection changed", "AbortError");
    }
    if (!offer.supported) return undefined;
    if (
      typeof offer.redirectUrl !== "string" ||
      !redirectAllowed(offer.redirectUrl) ||
      typeof offer.state !== "string" ||
      new URL(offer.redirectUrl).searchParams.get("state") !== offer.state
    )
      throw Error("Workspace app return unavailable");
    return { redirectUrl: offer.redirectUrl, state: offer.state };
  }

  function available(headers: unknown): boolean {
    if (!Array.isArray(headers)) return false;
    return headers.some(
      (header) =>
        header &&
        typeof header === "object" &&
        header.name === config.pluginName &&
        Array.isArray(header.methods) &&
        config.methods.every((name) =>
          header.methods.some(
            (method: unknown) =>
              !!method &&
              typeof method === "object" &&
              "name" in method &&
              method.name === name,
          ),
        ),
    );
  }

  /** Identity-ready consumer is independent of whether the connections panel is open. */
  function watch(
    port: WorkspaceAppReturnPort,
    binding: AccountReturnBinding,
    current: () => AccountReturnBinding | null,
    onReturn: (result: {
      result: "connected" | "denied" | "failed";
      connectionId?: string;
    }) => void,
    onError: () => void,
  ) {
    let closed = false,
      busy = false,
      queued = false,
      listener: { remove(): void | Promise<void> } | undefined;
    const valid = () => !closed && sameAccountReturnBinding(binding, current());
    const drain = async () => {
      if (!valid()) return;
      if (busy) {
        queued = true;
        return;
      }
      busy = true;
      try {
        const result = await port.consume(binding);
        if (!valid() || result.result === "none") return;
        if (
          !["connected", "denied", "failed"].includes(result.result) ||
          (result.result === "connected" &&
            !/^[A-Za-z0-9_-]{1,128}$/.test(result.connectionId ?? "")) ||
          (result.result !== "connected" && result.connectionId !== undefined)
        )
          throw Error("Invalid Workspace return");
        if (
          result.result === "connected" ||
          result.result === "denied" ||
          result.result === "failed"
        )
          onReturn({
            result: result.result,
            ...(result.connectionId
              ? { connectionId: result.connectionId }
              : {}),
          });
      } catch {
        if (valid()) onError();
      } finally {
        busy = false;
        if (queued && valid()) {
          queued = false;
          void drain();
        }
      }
    };
    const ready = port
      .subscribe(() => void drain())
      .then(
        (handle) => {
          listener = handle;
          if (closed) return handle.remove();
          return drain();
        },
        () => {
          if (valid()) onError();
        },
      );
    return {
      ready,
      close() {
        if (closed) return;
        closed = true;
        queued = false;
        void Promise.resolve(listener?.remove()).catch(() => {});
      },
    };
  }

  return Object.freeze({ redirectAllowed, prepare, available, watch });
}
