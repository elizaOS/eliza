import { logger } from "@/lib/utils/logger";

export type ApprovalCallbackEvent =
  | {
      name: "ApprovalApproved";
      approvalRequestId: string;
      signerIdentityId?: string;
      signatureText?: string;
      signedAt: Date;
    }
  | {
      name: "ApprovalDenied";
      approvalRequestId: string;
      reason?: string;
      deniedAt: Date;
    }
  | {
      name: "ApprovalCanceled";
      approvalRequestId: string;
      reason?: string;
      canceledAt: Date;
    }
  | {
      name: "ApprovalExpired";
      approvalRequestId: string;
      expiredAt: Date;
    };

export type ApprovalCallbackEventName = ApprovalCallbackEvent["name"];

export type ApprovalCallbackListener = (event: ApprovalCallbackEvent) => void | Promise<void>;

export interface ApprovalCallbackFilter {
  approvalRequestId?: string;
  name?: ApprovalCallbackEventName;
}

export interface ApprovalCallbackWaitFilter {
  approvalRequestId: string;
  names: Array<ApprovalCallbackEventName>;
}

export interface ApprovalCallbackBus {
  publish(event: ApprovalCallbackEvent): Promise<void>;
  subscribe(filter: ApprovalCallbackFilter, listener: ApprovalCallbackListener): () => void;
  waitFor(filter: ApprovalCallbackWaitFilter, timeoutMs: number): Promise<ApprovalCallbackEvent>;
}

export interface CreateApprovalCallbackBusDeps {
  record?: (event: ApprovalCallbackEvent) => Promise<void>;
}

interface Subscription {
  filter: ApprovalCallbackFilter;
  listener: ApprovalCallbackListener;
}

function matches(filter: ApprovalCallbackFilter, event: ApprovalCallbackEvent): boolean {
  if (filter.name && filter.name !== event.name) return false;
  if (filter.approvalRequestId && filter.approvalRequestId !== event.approvalRequestId) {
    return false;
  }
  return true;
}

export function createApprovalCallbackBus(
  deps?: CreateApprovalCallbackBusDeps,
): ApprovalCallbackBus {
  const subscriptions = new Set<Subscription>();
  const record = deps?.record;

  return {
    async publish(event: ApprovalCallbackEvent): Promise<void> {
      if (record) {
        try {
          await record(event);
        } catch (error) {
          logger.error("[ApprovalCallbackBus] record failed", {
            event: event.name,
            approvalRequestId: event.approvalRequestId,
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
            logger.error("[ApprovalCallbackBus] listener failed", {
              event: event.name,
              approvalRequestId: event.approvalRequestId,
              error,
            });
          }
        }),
      );
    },

    subscribe(filter: ApprovalCallbackFilter, listener: ApprovalCallbackListener): () => void {
      const sub: Subscription = { filter, listener };
      subscriptions.add(sub);
      return () => {
        subscriptions.delete(sub);
      };
    },

    waitFor(
      filter: ApprovalCallbackWaitFilter,
      timeoutMs: number,
    ): Promise<ApprovalCallbackEvent> {
      return new Promise<ApprovalCallbackEvent>((resolve, reject) => {
        const names = new Set<ApprovalCallbackEventName>(filter.names);
        let unsubscribe: (() => void) | null = null;
        const timer = setTimeout(() => {
          if (unsubscribe) unsubscribe();
          reject(
            new Error(
              `[ApprovalCallbackBus] waitFor timed out after ${timeoutMs}ms for approvalRequestId=${filter.approvalRequestId}`,
            ),
          );
        }, timeoutMs);

        unsubscribe = this.subscribe({ approvalRequestId: filter.approvalRequestId }, (event) => {
          if (!names.has(event.name)) return;
          clearTimeout(timer);
          if (unsubscribe) unsubscribe();
          resolve(event);
        });
      });
    },
  };
}

export const approvalCallbackBus = createApprovalCallbackBus();
