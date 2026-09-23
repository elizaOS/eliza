/**
 * Serializes protected HTTP frames through a host-owned delivery authority.
 * Authorization encloses only synchronous transport writes; socket backpressure
 * never holds the authority's transaction open. This protects callers of these
 * helpers, not arbitrary direct writes or independently attached route handlers.
 * Completion means the Node response finished, not that its recipient acknowledged it.
 */
import type { ServerResponse } from "node:http";
import { ElizaError } from "@elizaos/common";

export type HttpDeliveryOutcome =
  | { kind: "complete" }
  | { kind: "denied" }
  | { kind: "disconnected" }
  | { kind: "failed"; error: ElizaError };

type Frame = Readonly<{
  data: string;
  end: boolean;
  jsonStatus?: number;
}>;

type RequiredDelivery = {
  enqueue(frame: Frame): void;
  end(): Promise<HttpDeliveryOutcome>;
  completed: Promise<HttpDeliveryOutcome>;
};

const deliveries = new WeakMap<ServerResponse, RequiredDelivery>();

/**
 * Bind once, after request admission and before any protected response content.
 * maxPendingBytes is the host's explicit transport budget: an oversized frame or
 * backlog fails the entire pending response, never a successful truncated frame.
 */
export function bindRequiredHttpDelivery(
  response: ServerResponse,
  input: {
    deliver: (dispatch: () => undefined) => Promise<boolean>;
    maxPendingBytes: number;
  },
): RequiredDelivery {
  if (
    deliveries.has(response) ||
    response.headersSent ||
    response.destroyed ||
    !Number.isSafeInteger(input.maxPendingBytes) ||
    input.maxPendingBytes <= 0
  ) {
    throw new ElizaError(
      "Protected HTTP delivery must be bound before output with a positive byte budget",
      {
        code: "HTTP_DELIVERY_CONFIGURATION_INVALID",
      },
    );
  }
  const { deliver, maxPendingBytes } = input;
  const result = Promise.withResolvers<HttpDeliveryOutcome>();
  const queue: Frame[] = [];
  let pendingBytes = 0;
  let pumping = false;
  let ending = false;
  let endedByGuard = false;
  let nativeFinished = false;
  let finalDeliveryApproved = false;
  let settled = false;

  function settle(outcome: HttpDeliveryOutcome): void {
    if (settled) return;
    settled = true;
    queue.length = 0;
    pendingBytes = 0;
    response.off("finish", finished);
    response.off("close", disconnected);
    response.off("error", transportFailed);
    result.resolve(outcome);
    if (outcome.kind !== "complete") response.destroy();
  }
  function finished(): void {
    nativeFinished = true;
    if (!endedByGuard)
      settle({
        kind: "failed",
        error: new ElizaError("Response ended outside protected delivery", {
          code: "HTTP_DELIVERY_UNGUARDED_END",
        }),
      });
    else if (finalDeliveryApproved) settle({ kind: "complete" });
  }
  function disconnected(): void {
    if (!nativeFinished) settle({ kind: "disconnected" });
  }
  function transportFailed(cause: Error): void {
    settle({
      kind: "failed",
      error: new ElizaError("Protected HTTP transport failed", {
        code: "HTTP_DELIVERY_TRANSPORT_FAILED",
        cause,
      }),
    });
  }
  response.once("finish", finished);
  response.once("close", disconnected);
  response.once("error", transportFailed);

  async function drain(): Promise<void> {
    if (!response.writableNeedDrain || settled || response.destroyed) return;
    await new Promise<void>((resolve) => {
      const resume = () => {
        response.off("drain", resume);
        response.off("close", resume);
        response.off("finish", resume);
        resolve();
      };
      response.once("drain", resume);
      response.once("close", resume);
      response.once("finish", resume);
    });
  }

  async function pump(): Promise<void> {
    if (pumping || settled) return;
    pumping = true;
    try {
      while (queue.length > 0 && !settled) {
        const frame = queue[0];
        let dispatched = false;
        let needsDrain = false;
        const allowed = await deliver(() => {
          if (settled || response.destroyed) return;
          if (dispatched)
            throw new ElizaError(
              "Delivery authority dispatched a frame more than once",
              { code: "HTTP_DELIVERY_DUPLICATE_DISPATCH" },
            );
          dispatched = true;
          if (frame.jsonStatus !== undefined) {
            response.statusCode = frame.jsonStatus;
            response.setHeader("Content-Type", "application/json");
          }
          if (frame.end) {
            endedByGuard = true;
            response.end(frame.data);
          } else {
            needsDrain = !response.write(frame.data);
          }
        });
        if (settled) return;
        if (!allowed) {
          settle({ kind: "denied" });
          return;
        }
        if (!dispatched)
          throw new ElizaError("Delivery authority omitted dispatch", {
            code: "HTTP_DELIVERY_DISPATCH_MISSING",
          });
        if (frame.end) {
          finalDeliveryApproved = true;
          if (nativeFinished) {
            settle({ kind: "complete" });
            return;
          }
        }
        queue.shift();
        pendingBytes -= Buffer.byteLength(frame.data);
        if (needsDrain) await drain();
      }
    } catch (cause) {
      // error-policy:J1 Abort transport and expose an explicit failed delivery outcome.
      settle({
        kind: "failed",
        error: new ElizaError("Protected HTTP delivery failed", {
          code: "HTTP_DELIVERY_FAILED",
          cause,
        }),
      });
    } finally {
      pumping = false;
    }
  }

  const delivery: RequiredDelivery = Object.freeze({
    completed: result.promise,
    end(): Promise<HttpDeliveryOutcome> {
      if (!ending && !settled) delivery.enqueue({ data: "", end: true });
      return result.promise;
    },
    enqueue(frame: Frame): void {
      if (settled) return;
      if (ending) {
        settle({
          kind: "failed",
          error: new ElizaError(
            "Protected output was queued after response completion",
            { code: "HTTP_DELIVERY_ALREADY_ENDING" },
          ),
        });
        return;
      }
      const bytes = Buffer.byteLength(frame.data);
      if (bytes > maxPendingBytes - pendingBytes) {
        settle({
          kind: "failed",
          error: new ElizaError(
            "Protected HTTP output exceeded its transport budget; no partial frame was queued",
            {
              code: "HTTP_DELIVERY_BACKPRESSURE_EXCEEDED",
              context: { maxPendingBytes, pendingBytes, frameBytes: bytes },
            },
          ),
        });
        return;
      }
      ending = frame.end;
      pendingBytes += bytes;
      queue.push(Object.freeze({ ...frame }));
      // pump translates every failure into completed's explicit outcome.
      void pump();
    },
  });
  deliveries.set(response, delivery);
  return delivery;
}

/** Returns true even after denial; a bound response must never fall back. */
export function queueRequiredHttpFrame(
  response: ServerResponse,
  data: string,
): boolean {
  const delivery = deliveries.get(response);
  if (!delivery) return false;
  delivery.enqueue({ data, end: false });
  return true;
}

/** Preserve the legacy JSON responder only when the host installed no guard. */
export function queueRequiredHttpJson(
  response: ServerResponse,
  value: unknown,
  status: number,
): Promise<HttpDeliveryOutcome> | undefined {
  const delivery = deliveries.get(response);
  if (!delivery) return undefined;
  const data = JSON.stringify(value);
  if (data === undefined)
    throw new ElizaError("Protected JSON response is not serializable", {
      code: "HTTP_DELIVERY_JSON_INVALID",
    });
  delivery.enqueue({ data, end: true, jsonStatus: status });
  return delivery.completed;
}

/** End only after all accepted frames have passed current delivery authority. */
export function endRequiredHttpDelivery(
  response: ServerResponse,
): Promise<HttpDeliveryOutcome> | undefined {
  const delivery = deliveries.get(response);
  return delivery?.end();
}
