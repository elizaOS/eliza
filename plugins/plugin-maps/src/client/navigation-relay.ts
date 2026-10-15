type Request = (
  path: string,
  body: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
const PATH = "/api/client-devices/maps-navigation";

export interface MapsRelayHost<Owner extends object> {
  current(): Owner | null;
  execute(
    owner: Owner,
    operation: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  failure(error: unknown): string;
  connected(value: boolean, offerId: string): void;
}
/** Offers navigation only during this phone's authenticated resident turn. */
export async function withMapsNavigationRelay<T, Owner extends object>(
  host: MapsRelayHost<Owner>,
  request: Request | undefined,
  conversationId: string,
  signal: AbortSignal,
  send: () => Promise<T>,
): Promise<T> {
  const navigation = host.current();
  const offerId = crypto.randomUUID();
  if (!request || !navigation) return send();
  const lifetime = new AbortController(),
    current = AbortSignal.any([signal, lifetime.signal]);
  const poll = async (phase: "open" | "poll" = "poll") => {
    const value = await request(
      PATH,
      { phase, conversationId, offerId },
      current,
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid Maps navigation response");
    return value as Record<string, unknown>;
  };
  let retired: Promise<unknown> | undefined;
  const retire = () =>
    (retired ??= request(
      PATH,
      { phase: "retire", conversationId, offerId },
      AbortSignal.timeout(1_000),
    ).catch(() => undefined));
  let ready: Record<string, unknown>;
  try {
    ready = await poll("open");
  } catch {
    lifetime.abort();
    await retire();
    signal.throwIfAborted();
    return send();
  }
  if (ready.protocol !== 1 || ready.request !== null) {
    await retire();
    signal.throwIfAborted();
    return send();
  }
  host.connected(true, offerId);
  const delivered = new Set<string>();
  const receive = async () => {
    while (!current.aborted && host.current() === navigation) {
      const reply = await poll();
      if (reply.protocol !== 1) throw Error("Maps navigation protocol changed");
      if (reply.request !== null) {
        const command = reply.request as Record<string, unknown> | undefined;
        if (
          !command ||
          typeof command.id !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(command.id) ||
          delivered.has(command.id) ||
          typeof command.expiresAt !== "number" ||
          command.expiresAt <= Date.now() ||
          command.expiresAt > Date.now() + 30_000
        )
          throw Error("Invalid Maps navigation request");
        delivered.add(command.id);
        const operation = command.operation as
          | Record<string, unknown>
          | undefined;
        const bounded = AbortSignal.any([
          current,
          AbortSignal.timeout(Math.max(1, command.expiresAt - Date.now())),
        ]);
        let result: Record<string, unknown>;
        try {
          bounded.throwIfAborted();
          if (host.current() !== navigation)
            throw Error("Maps account changed");
          const status = await host.execute(navigation, operation, bounded);
          bounded.throwIfAborted();
          if (host.current() !== navigation)
            throw Error("Maps account changed");
          result = { status };
        } catch (error) {
          result = { failed: { code: host.failure(error) } };
        }
        current.throwIfAborted();
        // A failed or lost acknowledgement is never retried: the phone may have acted.
        await request(
          PATH,
          {
            phase: "result",
            conversationId,
            offerId,
            id: command.id,
            ...result,
          },
          current,
        );
      }
    }
  };
  const receiving = receive().catch(async () => {
    lifetime.abort();
    await retire();
  });
  try {
    return await send();
  } finally {
    lifetime.abort();
    await receiving;
    host.connected(false, offerId);
    // Best-effort retirement cannot replay a navigation request or retain a turn.
    await retire();
  }
}
