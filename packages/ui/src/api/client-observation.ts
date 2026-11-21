import {
  type ClientCalendarDayObservation,
  type ClientLocationObservation,
  type ClientTurnObservationOptionalField,
  type ClientTurnObservationSupport,
  readClientTurnObservationPeerSupport,
} from "@elizaos/contracts/client-turn-observation";
import { normalizeRemoteAgentPairingInstanceId } from "@elizaos/contracts/remote-agent-pairing";
export interface ObservationSessionIdentity {
  readonly origin: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly sessionId: string;
}
type ObservationContext = {
  view: string;
  revision: number;
  calendarDay?: ClientCalendarDayObservation;
  location?: ClientLocationObservation;
};
type SupportedObservation<T> = Omit<T, "calendarDay" | "location"> & {
  calendarDay?: ClientCalendarDayObservation;
  location?: ClientLocationObservation;
};

export interface ClientObservationBinding extends ObservationSessionIdentity {
  connectionEpoch: number;
  /** Existing API-process pairing instance, learned through the authenticated handshake. */
  serverInstanceId: string;
}
/** Format support belongs to one current authenticated session and API-process lifetime. */
export class ClientObservationSupportCache {
  private binding: string | null = null;
  private support: ClientTurnObservationSupport | undefined;
  clear() {
    this.binding = null;
    this.support = undefined;
  }
  private key(binding: ClientObservationBinding): string | undefined {
    const instance = normalizeRemoteAgentPairingInstanceId(
      binding.serverInstanceId,
    );
    if (
      !instance ||
      !Number.isSafeInteger(binding.connectionEpoch) ||
      binding.connectionEpoch < 0 ||
      ![
        binding.origin,
        binding.ownerId,
        binding.agentId,
        binding.sessionId,
      ].every((value) => typeof value === "string" && value.length > 0)
    )
      return;
    return JSON.stringify([
      binding.origin,
      binding.ownerId,
      binding.agentId,
      binding.sessionId,
      binding.connectionEpoch,
      instance,
    ]);
  }
  admit(status: unknown, binding: ClientObservationBinding): boolean {
    this.clear();
    const key = this.key(binding);
    if (!key) return false;
    const support = readClientTurnObservationPeerSupport(
      status,
      binding.serverInstanceId,
    );
    if (!support) return false;
    this.binding = key;
    this.support = support;
    return true;
  }
  supports(
    binding: ClientObservationBinding,
    field: ClientTurnObservationOptionalField,
  ): boolean {
    const key = this.key(binding);
    return (
      key !== undefined &&
      key === this.binding &&
      this.support?.optionalFields.includes(field) === true
    );
  }
  calendarDaySupported(binding: ClientObservationBinding): boolean {
    return this.supports(binding, "calendarDay");
  }
}
/** Strip each unsupported optional field without changing the ordinary observation. */
export function contextForObservationSupport<T extends ObservationContext>(
  context: T,
  cache: ClientObservationSupportCache,
  binding: ClientObservationBinding | undefined,
): SupportedObservation<T> {
  const { calendarDay, location, ...ordinary } = context;
  return {
    ...ordinary,
    ...(calendarDay && binding && cache.supports(binding, "calendarDay")
      ? { calendarDay: { ...calendarDay } }
      : {}),
    ...(location && binding && cache.supports(binding, "location")
      ? { location: { ...location } }
      : {}),
  };
}

/** One verified session handshake, followed by a fresh comparison before optional-field use. */
export class ClientObservationSupportSession {
  private readonly cache = new ClientObservationSupportCache();
  private readonly session: Readonly<
    Omit<ClientObservationBinding, "serverInstanceId">
  >;
  private known: ClientObservationBinding | undefined;
  private initial: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
  private retired = false;
  constructor(
    session: Omit<ClientObservationBinding, "serverInstanceId">,
    private readonly current: () => boolean,
    private readonly status: (signal: AbortSignal) => Promise<unknown>,
  ) {
    this.session = Object.freeze({ ...session });
  }
  clear() {
    this.retired = true;
    this.lifetime.abort();
    this.known = undefined;
    this.cache.clear();
  }
  private check(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.retired || !this.current())
      throw new DOMException("The observation session changed", "AbortError");
  }
  /** Learning happens only here, once. A later process nonce is never learned under this session. */
  async handshake(signal: AbortSignal): Promise<void> {
    this.check(signal);
    // The shared negotiation belongs to the session, not its first requesting turn.
    this.initial ??= this.learn(this.lifetime.signal);
    const initial = this.initial;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      initial.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
    this.check(signal);
  }
  private async learn(signal: AbortSignal): Promise<void> {
    this.check(signal);
    try {
      const status = await this.status(signal);
      this.check(signal);
      const instance =
        status && typeof status === "object" && !Array.isArray(status)
          ? normalizeRemoteAgentPairingInstanceId(
              Reflect.get(status, "serverInstanceId"),
            )
          : null;
      if (!instance) return;
      const binding = { ...this.session, serverInstanceId: instance };
      if (this.cache.admit(status, binding))
        this.known = Object.freeze(binding);
    } catch {
      this.known = undefined;
      this.cache.clear();
      this.check(signal);
    }
  }
  /** An old/unreadable peer omits only the optional field; ordinary context remains intact. */
  async context<T extends ObservationContext>(
    context: T,
    signal: AbortSignal,
  ): Promise<SupportedObservation<T>> {
    const ordinary = contextForObservationSupport(
      context,
      this.cache,
      undefined,
    );
    this.check(signal);
    const wanted = (["calendarDay", "location"] as const).filter(
      (field) => context[field] !== undefined,
    );
    if (!wanted.length) return ordinary;
    await this.handshake(signal);
    this.check(signal);
    const binding = this.known;
    if (
      !binding ||
      !wanted.some((field) => this.cache.supports(binding, field))
    )
      return ordinary;
    try {
      const status = await this.status(signal);
      this.check(signal);
      if (!this.cache.admit(status, binding)) {
        this.known = undefined;
        return ordinary;
      }
      return contextForObservationSupport(context, this.cache, binding);
    } catch {
      this.known = undefined;
      this.cache.clear();
      this.check(signal);
      return ordinary;
    }
  }
}
