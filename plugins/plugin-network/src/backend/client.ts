/** Signed HTTP client for the Network service's /internal/* endpoints (the Eliza side's NetworkBackend). */
import { boundedFetch } from "@elizaos/cloud-services-common/transport";
import {
  SET_STATE_PATH,
  type SetStateRequest,
  type SetStateResponse,
  SIGNALS_PATH,
  type SignalsRequest,
  type SignalsResponse,
  TURN_PATH,
  TURN_RECEIPT_PATH,
  type TurnReceiptRequest,
  type TurnReceiptResponse,
  type TurnRequest,
  type TurnResponse,
  UPDATES_PATH,
  type UpdatesRequest,
  type UpdatesResponse,
} from "./contract.js";
import { svcSign } from "./svc-auth.js";

export interface NetworkServiceClientOptions {
  /** Service origin, e.g. https://network-service.up.railway.app (no trailing slash needed). */
  baseUrl: string;
  /** SERVICE_TURN_SECRET. */
  secret: string;
  fetch?: typeof fetch;
  /** Per-request timeout (ms). Default 8000: the turn budget is p95 < 8 s end to end. */
  timeoutMs?: number;
}

export class NetworkServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class NetworkServiceClient {
  readonly #o: Required<Omit<NetworkServiceClientOptions, "fetch">> & {
    fetch: typeof fetch;
  };
  constructor(o: NetworkServiceClientOptions) {
    this.#o = {
      timeoutMs: 8000,
      ...o,
      baseUrl: o.baseUrl.replace(/\/+$/, ""),
      fetch: o.fetch ?? fetch.bind(globalThis),
    };
  }

  async #post<T>(path: string, id: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    const headers = await svcSign(this.#o.secret, {
      method: "POST",
      path,
      id,
      body,
    });
    const res = await boundedFetch(
      `${this.#o.baseUrl}${path}`,
      {
        method: "POST",
        // Workerd supports manual redirects; the status check below rejects
        // every 3xx without forwarding the service credential.
        redirect: "manual",
        headers: { "content-type": "application/json", ...headers },
        body,
      },
      {
        timeoutMs: this.#o.timeoutMs,
        maxResponseBytes: 4 * 1024 * 1024,
        fetchImpl: this.#o.fetch,
        invalidBoundsError: () =>
          new NetworkServiceError(0, "Invalid Network request bounds"),
        responseTooLargeError: () =>
          new NetworkServiceError(
            0,
            "Network service response exceeds body limit",
          ),
        timeoutMessage: "Network service request deadline expired",
        cancellationMessage: "Network service request cancelled",
      },
    );
    if (!res.ok)
      throw new NetworkServiceError(res.status, `${path} -> ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new NetworkServiceError(
        res.status,
        "Network service returned invalid JSON",
      );
    }
  }

  /** One inbound message. Idempotent by messageId. */
  turn(req: TurnRequest): Promise<TurnResponse> {
    return this.#post<TurnResponse>(TURN_PATH, req.messageId, req);
  }

  /** Acknowledge provider acceptance separately from collecting a reply. */
  turnReceipt(req: TurnReceiptRequest): Promise<TurnReceiptResponse> {
    return this.#post<TurnReceiptResponse>(
      TURN_RECEIPT_PATH,
      `${req.messageId}:receipt`,
      req,
    );
  }

  setState(req: SetStateRequest): Promise<SetStateResponse> {
    return this.#post<SetStateResponse>(
      SET_STATE_PATH,
      req.idempotencyKey,
      req,
    );
  }

  recordSignals(req: SignalsRequest): Promise<SignalsResponse> {
    return this.#post<SignalsResponse>(
      SIGNALS_PATH,
      `${req.messageId}:signals`,
      req,
    );
  }

  readUpdates(req: UpdatesRequest): Promise<UpdatesResponse> {
    return this.#post<UpdatesResponse>(
      UPDATES_PATH,
      `${req.messageId}:updates`,
      req,
    );
  }
}
