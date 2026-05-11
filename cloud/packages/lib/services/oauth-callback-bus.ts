import { logger } from "@/lib/utils/logger";

export type OAuthCallbackEvent =
  | {
      name: "OAuthCallbackReceived";
      intentId: string;
      provider: string;
      status: "bound" | "denied";
      tokenSetEncrypted?: string;
      scopesGranted?: string[];
      connectorIdentityId?: string;
      receivedAt: Date;
    }
  | {
      name: "OAuthBindFailed";
      intentId: string;
      provider: string;
      error: string;
      failedAt: Date;
    };

export type OAuthCallbackEventName = OAuthCallbackEvent["name"];

export type OAuthCallbackListener = (
  event: OAuthCallbackEvent,
) => void | Promise<void>;

export interface OAuthCallbackFilter {
  intentId?: string;
  name?: OAuthCallbackEventName;
}

export interface OAuthCallbackWaitFilter {
  intentId: string;
  names: Array<OAuthCallbackEventName>;
}

export interface OAuthCallbackBus {
  publish(event: OAuthCallbackEvent): Promise<void>;
  subscribe(
    filter: OAuthCallbackFilter,
    listener: OAuthCallbackListener,
  ): () => void;
  waitFor(
    filter: OAuthCallbackWaitFilter,
    timeoutMs: number,
  ): Promise<OAuthCallbackEvent>;
}

export interface CreateOAuthCallbackBusDeps {
  record?: (event: OAuthCallbackEvent) => Promise<void>;
}

interface Subscription {
  filter: OAuthCallbackFilter;
  listener: OAuthCallbackListener;
}

function matches(
  filter: OAuthCallbackFilter,
  event: OAuthCallbackEvent,
): boolean {
  if (filter.name && filter.name !== event.name) return false;
  if (filter.intentId && filter.intentId !== event.intentId) return false;
  return true;
}

export function createOAuthCallbackBus(
  deps?: CreateOAuthCallbackBusDeps,
): OAuthCallbackBus {
  const subscriptions = new Set<Subscription>();
  const record = deps?.record;

  return {
    async publish(event: OAuthCallbackEvent): Promise<void> {
      if (record) {
        try {
          await record(event);
        } catch (error) {
          logger.error("[OAuthCallbackBus] record failed", {
            event: event.name,
            intentId: event.intentId,
            error,
          });
        }
      }

      const snapshot = Array.from(subscriptions);
      await Promise.all(
        snapshot.map(async (sub) => {
          if (!matches(sub.filter, event)) return;
          try {
            await sub.listener(event);
          } catch (error) {
            logger.error("[OAuthCallbackBus] listener failed", {
              event: event.name,
              intentId: event.intentId,
              error,
            });
          }
        }),
      );
    },

    subscribe(
      filter: OAuthCallbackFilter,
      listener: OAuthCallbackListener,
    ): () => void {
      const sub: Subscription = { filter, listener };
      subscriptions.add(sub);
      return () => {
        subscriptions.delete(sub);
      };
    },

    waitFor(
      filter: OAuthCallbackWaitFilter,
      timeoutMs: number,
    ): Promise<OAuthCallbackEvent> {
      return new Promise<OAuthCallbackEvent>((resolve, reject) => {
        const names = new Set<OAuthCallbackEventName>(filter.names);
        let unsubscribe: (() => void) | null = null;
        const timer = setTimeout(() => {
          if (unsubscribe) unsubscribe();
          reject(
            new Error(
              `[OAuthCallbackBus] waitFor timed out after ${timeoutMs}ms for intentId=${filter.intentId}`,
            ),
          );
        }, timeoutMs);

        unsubscribe = this.subscribe(
          { intentId: filter.intentId },
          (event) => {
            if (!names.has(event.name)) return;
            clearTimeout(timer);
            if (unsubscribe) unsubscribe();
            resolve(event);
          },
        );
      });
    },
  };
}
