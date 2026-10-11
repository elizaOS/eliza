/** Signed HTTP client for the Network service's /internal/* endpoints (the Eliza side's NetworkBackend). */
import { boundedFetch } from "@elizaos/cloud-services-common/transport";
import { NETWORK_MEMBER_STATES } from "../types.js";
import {
  NETWORK_APP_IDS,
  RELAY_PATH,
  type RelaySendRequest,
  type RelaySendResponse,
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

const NETWORK_APPS = new Set<string>(NETWORK_APP_IDS);
const MEMBER_STATES = new Set<string>(NETWORK_MEMBER_STATES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNetworkApp(value: unknown): boolean {
  return typeof value === "string" && NETWORK_APPS.has(value);
}

function isTurnContext(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isStringOrNull(value.firstName) ||
    !isStringOrNull(value.city) ||
    typeof value.state !== "string" ||
    !MEMBER_STATES.has(value.state) ||
    !isStringOrNull(value.stateFrom) ||
    !isStringOrNull(value.stateUntil) ||
    !Array.isArray(value.facets) ||
    !value.facets.every((facet) => typeof facet === "string") ||
    typeof value.singlePlayer !== "boolean"
  )
    return false;
  return (
    value.activeItems === null ||
    (Array.isArray(value.activeItems) &&
      value.activeItems.every(
        (item) =>
          isRecord(item) &&
          typeof item.id === "string" &&
          typeof item.kind === "string" &&
          typeof item.summary === "string",
      ))
  );
}

function isConsent(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.state === "opted_out" || value.state === "opted_in") &&
    (value.scope === "all" || value.scope === "app") &&
    (value.app === null || isNetworkApp(value.app)) &&
    Number.isSafeInteger(value.at)
  );
}

function isTurnResponse(value: unknown): value is TurnResponse {
  if (!isRecord(value)) return false;
  if (value.outcome === "ignored") return typeof value.reason === "string";
  if (value.outcome === "open") {
    return (
      (value.channel === "blooio" || value.channel === "twilio") &&
      isNetworkApp(value.app) &&
      typeof value.memberId === "string" &&
      isTurnContext(value.context)
    );
  }
  if (value.outcome !== "handled") return false;
  return (
    Array.isArray(value.replies) &&
    value.replies.every((reply) => typeof reply === "string") &&
    Array.isArray(value.replyIds) &&
    value.replyIds.every((id) => typeof id === "string") &&
    value.delivery === "collected" &&
    (value.replyKind === "reply" || value.replyKind === "compliance") &&
    typeof value.accountEligible === "boolean" &&
    (value.app === null || isNetworkApp(value.app)) &&
    isStringOrNull(value.memberId) &&
    typeof value.reason === "string" &&
    (value.consent === undefined || isConsent(value.consent))
  );
}

function isTurnReceiptResponse(value: unknown): value is TurnReceiptResponse {
  return (
    isRecord(value) && value.ok === true && typeof value.replayed === "boolean"
  );
}

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
  async turn(req: TurnRequest): Promise<TurnResponse> {
    const result = await this.#post<unknown>(TURN_PATH, req.messageId, req);
    if (!isTurnResponse(result))
      throw new NetworkServiceError(
        200,
        "Network service returned an invalid turn response",
      );
    return result;
  }

  /** Acknowledge provider acceptance separately from collecting a reply. */
  async turnReceipt(req: TurnReceiptRequest): Promise<TurnReceiptResponse> {
    const result = await this.#post<unknown>(
      TURN_RECEIPT_PATH,
      `${req.messageId}:receipt`,
      req,
    );
    if (!isTurnReceiptResponse(result))
      throw new NetworkServiceError(
        200,
        "Network service returned an invalid turn receipt",
      );
    return result;
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

  /** Ask the service to relay the member's message to a match. Idempotent by messageId. */
  async relay(req: RelaySendRequest): Promise<RelaySendResponse> {
    const result = await this.#post<RelaySendResponse>(
      RELAY_PATH,
      `${req.messageId}:relay`,
      req,
    );
    if (
      !result ||
      typeof result !== "object" ||
      !["pass", "hold", "block", "none"].includes(result.decision) ||
      typeof result.senderNotice !== "string" ||
      typeof result.delivered !== "boolean" ||
      typeof result.replayed !== "boolean" ||
      (result.delivered && result.decision !== "pass")
    )
      throw new NetworkServiceError(
        200,
        "Network service returned an invalid relay receipt",
      );
    return result;
  }
}
