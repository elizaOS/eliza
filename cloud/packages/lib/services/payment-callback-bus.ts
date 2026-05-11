import { logger } from "@/lib/utils/logger";

export type PaymentProvider = "stripe" | "oxapay" | "x402" | "wallet_native";

export type PaymentCallbackEvent =
  | {
      name: "PaymentSettled";
      paymentRequestId: string;
      provider: PaymentProvider;
      txRef?: string;
      amountCents?: number;
      currency?: string;
      payerIdentityId?: string;
      payerUserId?: string;
      settledAt: Date;
    }
  | {
      name: "PaymentFailed";
      paymentRequestId: string;
      provider: PaymentProvider;
      error: string;
      failedAt: Date;
    };

export type PaymentCallbackEventName = PaymentCallbackEvent["name"];

export type PaymentCallbackListener = (
  event: PaymentCallbackEvent,
) => void | Promise<void>;

export interface PaymentCallbackFilter {
  paymentRequestId?: string;
  name?: PaymentCallbackEventName;
}

export interface PaymentCallbackWaitFilter {
  paymentRequestId: string;
  names: Array<PaymentCallbackEventName>;
}

export interface PaymentCallbackBus {
  publish(event: PaymentCallbackEvent): Promise<void>;
  subscribe(
    filter: PaymentCallbackFilter,
    listener: PaymentCallbackListener,
  ): () => void;
  waitFor(
    filter: PaymentCallbackWaitFilter,
    timeoutMs: number,
  ): Promise<PaymentCallbackEvent>;
}

export interface CreatePaymentCallbackBusDeps {
  record?: (event: PaymentCallbackEvent) => Promise<void>;
}

interface Subscription {
  filter: PaymentCallbackFilter;
  listener: PaymentCallbackListener;
}

function matches(
  filter: PaymentCallbackFilter,
  event: PaymentCallbackEvent,
): boolean {
  if (filter.name && filter.name !== event.name) return false;
  if (
    filter.paymentRequestId &&
    filter.paymentRequestId !== event.paymentRequestId
  ) {
    return false;
  }
  return true;
}

export function createPaymentCallbackBus(
  deps?: CreatePaymentCallbackBusDeps,
): PaymentCallbackBus {
  const subscriptions = new Set<Subscription>();
  const record = deps?.record;

  return {
    async publish(event: PaymentCallbackEvent): Promise<void> {
      if (record) {
        try {
          await record(event);
        } catch (error) {
          logger.error("[PaymentCallbackBus] record failed", {
            event: event.name,
            paymentRequestId: event.paymentRequestId,
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
            logger.error("[PaymentCallbackBus] listener failed", {
              event: event.name,
              paymentRequestId: event.paymentRequestId,
              error,
            });
          }
        }),
      );
    },

    subscribe(
      filter: PaymentCallbackFilter,
      listener: PaymentCallbackListener,
    ): () => void {
      const sub: Subscription = { filter, listener };
      subscriptions.add(sub);
      return () => {
        subscriptions.delete(sub);
      };
    },

    waitFor(
      filter: PaymentCallbackWaitFilter,
      timeoutMs: number,
    ): Promise<PaymentCallbackEvent> {
      return new Promise<PaymentCallbackEvent>((resolve, reject) => {
        const names = new Set<PaymentCallbackEventName>(filter.names);
        let unsubscribe: (() => void) | null = null;
        const timer = setTimeout(() => {
          if (unsubscribe) unsubscribe();
          reject(
            new Error(
              `[PaymentCallbackBus] waitFor timed out after ${timeoutMs}ms for paymentRequestId=${filter.paymentRequestId}`,
            ),
          );
        }, timeoutMs);

        unsubscribe = this.subscribe(
          { paymentRequestId: filter.paymentRequestId },
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
