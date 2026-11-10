/** Relative timer receipts for reserved cache identities on the private gate binding. */
import {
  CACHE_CIRCUIT_COOLDOWN_MS,
  CACHE_CIRCUIT_ID_PREFIX,
} from "@elizaos/cloud-shared/lib/cache/cache-circuit-clock";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { isValidUUID } from "@elizaos/cloud-shared/lib/utils/validation";

const CLOCK_KEY = "cache-circuit-clock";
interface ClockReceipt {
  generation: number;
  owner: string;
  ready: boolean;
}

export class CacheCircuitClock {
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { owner: string; timer: ReturnType<typeof setTimeout> };

  constructor(
    private readonly state: DurableObjectState,
    private readonly objectName: string,
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async handle(request: Request): Promise<Response> {
    const clientId = this.objectName.slice(CACHE_CIRCUIT_ID_PREFIX.length);
    if (!isValidUUID(clientId))
      return new Response("Invalid cache identity", { status: 400 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid cache clock body", { status: 400 });
    }
    const generation = (body as { generation?: unknown } | null)?.generation;
    if (
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      return new Response("Invalid cache clock generation", { status: 400 });
    return this.serial(async () => {
      const saved = await this.state.storage.get<ClockReceipt>(CLOCK_KEY);
      if (
        saved &&
        (!Number.isSafeInteger(saved.generation) ||
          saved.generation < 1 ||
          typeof saved.owner !== "string" ||
          typeof saved.ready !== "boolean")
      )
        return new Response("Invalid original cache clock state", {
          status: 503,
        });
      if (saved && saved.generation > generation)
        return new Response("Stale cache clock generation", { status: 409 });
      if (
        saved?.generation === generation &&
        (saved.ready || saved.owner === this.pending?.owner)
      )
        return Response.json({ clientId, generation, ready: saved.ready });

      // A lost callback or object restart can only extend the original wait.
      const owner = crypto.randomUUID();
      await this.state.storage.put(CLOCK_KEY, {
        generation,
        owner,
        ready: false,
      });
      if (this.pending) clearTimeout(this.pending.timer);
      const timer = setTimeout(() => {
        void this.serial(async () => {
          const current = await this.state.storage.get<ClockReceipt>(CLOCK_KEY);
          if (current?.generation === generation && current.owner === owner)
            await this.state.storage.put(CLOCK_KEY, {
              ...current,
              ready: true,
            });
          if (this.pending?.owner === owner) this.pending = undefined;
        }).catch((error) => {
          if (this.pending?.owner === owner) this.pending = undefined;
          logger.error(
            "[CacheCircuitClock] Timer receipt remains unconfirmed",
            { error },
          );
        });
      }, CACHE_CIRCUIT_COOLDOWN_MS + 1);
      this.pending = { owner, timer };
      return Response.json({ clientId, generation, ready: false });
    });
  }
}
