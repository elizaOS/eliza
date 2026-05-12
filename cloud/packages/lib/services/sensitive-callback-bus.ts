import { logger } from "@/lib/utils/logger";

export type SensitiveCallbackEvent =
  | {
      name: "SensitiveRequestSubmitted";
      sensitiveRequestId: string;
      submittedAt: Date;
      actorIdentityId?: string;
    }
  | {
      name: "SensitiveRequestExpired";
      sensitiveRequestId: string;
      expiredAt: Date;
    }
  | {
      name: "SensitiveRequestCanceled";
      sensitiveRequestId: string;
      canceledAt: Date;
      reason?: string;
    };

export type SensitiveCallbackEventName = SensitiveCallbackEvent["name"];

export type SensitiveCallbackListener = (event: SensitiveCallbackEvent) => void | Promise<void>;

export interface SensitiveCallbackFilter {
  sensitiveRequestId?: string;
  name?: SensitiveCallbackEventName;
}

export interface SensitiveCallbackWaitFilter {
  sensitiveRequestId: string;
  names: Array<SensitiveCallbackEventName>;
}

export interface SensitiveCallbackBus {
  publish(event: SensitiveCallbackEvent): Promise<void>;
  subscribe(filter: SensitiveCallbackFilter, listener: SensitiveCallbackListener): () => void;
  waitFor(filter: SensitiveCallbackWaitFilter, timeoutMs: number): Promise<SensitiveCallbackEvent>;
}

export interface CreateSensitiveCallbackBusDeps {
  record?: (event: SensitiveCallbackEvent) => Promise<void>;
}

interface Subscription {
  filter: SensitiveCallbackFilter;
  listener: SensitiveCallbackListener;
}

function matches(filter: SensitiveCallbackFilter, event: SensitiveCallbackEvent): boolean {
  if (filter.name && filter.name !== event.name) return false;
  if (filter.sensitiveRequestId && filter.sensitiveRequestId !== event.sensitiveRequestId) {
    return false;
  }
  return true;
}

export function createSensitiveCallbackBus(
  deps?: CreateSensitiveCallbackBusDeps,
): SensitiveCallbackBus {
  const subscriptions = new Set<Subscription>();
  const record = deps?.record;

  return {
    async publish(event: SensitiveCallbackEvent): Promise<void> {
      if (record) {
        try {
          await record(event);
        } catch (error) {
          logger.error("[SensitiveCallbackBus] record failed", {
            event: event.name,
            sensitiveRequestId: event.sensitiveRequestId,
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
            logger.error("[SensitiveCallbackBus] listener failed", {
              event: event.name,
              sensitiveRequestId: event.sensitiveRequestId,
              error,
            });
          }
        }),
      );
    },

    subscribe(filter: SensitiveCallbackFilter, listener: SensitiveCallbackListener): () => void {
      const sub: Subscription = { filter, listener };
      subscriptions.add(sub);
      return () => {
        subscriptions.delete(sub);
      };
    },

    waitFor(
      filter: SensitiveCallbackWaitFilter,
      timeoutMs: number,
    ): Promise<SensitiveCallbackEvent> {
      return new Promise<SensitiveCallbackEvent>((resolve, reject) => {
        const names = new Set<SensitiveCallbackEventName>(filter.names);
        let unsubscribe: (() => void) | null = null;
        const timer = setTimeout(() => {
          if (unsubscribe) unsubscribe();
          reject(
            new Error(
              `[SensitiveCallbackBus] waitFor timed out after ${timeoutMs}ms for sensitiveRequestId=${filter.sensitiveRequestId}`,
            ),
          );
        }, timeoutMs);

        unsubscribe = this.subscribe({ sensitiveRequestId: filter.sensitiveRequestId }, (event) => {
          if (!names.has(event.name)) return;
          clearTimeout(timer);
          if (unsubscribe) unsubscribe();
          resolve(event);
        });
      });
    },
  };
}
