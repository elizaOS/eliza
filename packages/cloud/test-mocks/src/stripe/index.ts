/** Stateful, loopback-only fake for deterministic Stripe Checkout boundary tests. */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

export interface FakeStripeCustomer {
  id: string;
  object: "customer";
  created: number;
  livemode: false;
  email: string | null;
  name: string | null;
  metadata: Record<string, string>;
}

export interface FakeStripeCheckoutSession {
  id: string;
  object: "checkout.session";
  url: string;
  customer: string;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  amount_total: number;
  currency: string;
  payment_status: "unpaid" | "paid";
  status: "open" | "complete";
  payment_intent: string | null;
  created: number;
  livemode: false;
}

export interface FakeStripeRequest {
  method: string;
  path: string;
  query: Record<string, string[]>;
  headers: Record<string, string>;
  body: string;
  form: Record<string, string[]>;
}

export interface FakeStripeEffect {
  kind: "checkout.session.create";
  id: string;
  idempotencyKey: string | null;
  committedAt: number;
}

export interface FakeStripeState {
  requests: FakeStripeRequest[];
  customers: Map<string, FakeStripeCustomer>;
  sessions: Map<string, FakeStripeCheckoutSession>;
  effects: FakeStripeEffect[];
  counters: {
    customerCreateAttempts: number;
    customersCreated: number;
    checkoutSessionCreateAttempts: number;
    checkoutSessionsCreated: number;
    checkoutSessionCreateResponsesLost: number;
  };
}

export interface RunningFakeStripe {
  /** Provider origin. The Stripe client should add its normal `/v1` paths. */
  url: string;
  port: number;
  state: FakeStripeState;
  /** Commit the next new Checkout Session, then close its socket before any response byte. */
  loseNextCheckoutSessionCreateResponseAfterCommit(): void;
  /** Applies the provider-side payment transition used to build a signed completion webhook. */
  completeCheckoutSession(sessionId: string): FakeStripeCheckoutSession;
  stop(): Promise<void>;
}

export interface StartFakeStripeOptions {
  /** Listen port. Zero (the default) asks the OS for a free port. */
  port?: number;
}

interface IdempotentResult<T> {
  fingerprint: string;
  value: T;
}

interface MutableFakeStripeState extends FakeStripeState {
  customerIdempotency: Map<string, IdempotentResult<FakeStripeCustomer>>;
  sessionIdempotency: Map<string, IdempotentResult<FakeStripeCheckoutSession>>;
  nextCustomerId: number;
  nextSessionId: number;
  checkoutResponseLossesRemaining: number;
  checkoutResponseLossTargetKey: string | null;
}

/**
 * Starts a deliberately small Stripe-compatible HTTP surface. It always binds
 * to IPv4 loopback and never accepts a hostname override, so synthetic provider
 * traffic cannot accidentally leave the local machine.
 */
export async function startFakeStripe(
  options: StartFakeStripeOptions = {},
): Promise<RunningFakeStripe> {
  const state: MutableFakeStripeState = {
    requests: [],
    customers: new Map(),
    sessions: new Map(),
    effects: [],
    counters: {
      customerCreateAttempts: 0,
      customersCreated: 0,
      checkoutSessionCreateAttempts: 0,
      checkoutSessionsCreated: 0,
      checkoutSessionCreateResponsesLost: 0,
    },
    customerIdempotency: new Map(),
    sessionIdempotency: new Map(),
    nextCustomerId: 1,
    nextSessionId: 1,
    checkoutResponseLossesRemaining: 0,
    checkoutResponseLossTargetKey: null,
  };
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    void handleRequest(incoming, outgoing, state);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, LOOPBACK_HOST);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server, sockets);
    throw new Error("Fake Stripe did not bind to a numeric loopback port");
  }

  return {
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    port: address.port,
    state,
    loseNextCheckoutSessionCreateResponseAfterCommit() {
      // stripe-node replays an idempotent POST once even with its configured
      // network retry count at zero. Lose both the commit response and that
      // SDK replay so the application must reconcile with a list operation.
      state.checkoutResponseLossesRemaining = 2;
      state.checkoutResponseLossTargetKey = null;
    },
    completeCheckoutSession(sessionId) {
      const session = state.sessions.get(sessionId);
      if (!session) {
        throw new Error(
          `Cannot complete missing fake Stripe Session ${sessionId}`,
        );
      }
      session.payment_status = "paid";
      session.status = "complete";
      session.payment_intent =
        session.payment_intent ?? paymentIntentId(session.id);
      return session;
    },
    stop: () => closeServer(server, sockets),
  };
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  state: MutableFakeStripeState,
): Promise<void> {
  try {
    if (!isLoopback(incoming.socket.remoteAddress)) {
      writeStripeError(outgoing, 403, "api_error", "Loopback requests only");
      return;
    }

    const method = incoming.method ?? "GET";
    const requestUrl = new URL(incoming.url ?? "/", `http://${LOOPBACK_HOST}`);
    const body =
      method === "GET" || method === "HEAD" ? "" : await readBody(incoming);
    const form = new URLSearchParams(body);
    state.requests.push({
      method,
      path: requestUrl.pathname,
      query: collectParams(requestUrl.searchParams),
      headers: inspectableHeaders(incoming.headers),
      body,
      form: collectParams(form),
    });

    if (!hasBearerAuthorization(incoming.headers.authorization)) {
      writeStripeError(
        outgoing,
        401,
        "invalid_request_error",
        "Invalid API Key provided",
      );
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/v1/customers/search") {
      searchCustomers(outgoing, requestUrl.searchParams, state);
      return;
    }
    if (method === "POST" && requestUrl.pathname === "/v1/customers") {
      createCustomer(outgoing, form, body, incoming.headers, state);
      return;
    }
    const customerMatch = /^\/v1\/customers\/([^/]+)$/.exec(
      requestUrl.pathname,
    );
    if (method === "GET" && customerMatch?.[1]) {
      retrieveCustomer(outgoing, decodeURIComponent(customerMatch[1]), state);
      return;
    }
    if (method === "POST" && requestUrl.pathname === "/v1/checkout/sessions") {
      createCheckoutSession(outgoing, form, body, incoming.headers, state);
      return;
    }
    if (method === "GET" && requestUrl.pathname === "/v1/checkout/sessions") {
      listCheckoutSessions(outgoing, requestUrl.searchParams, state);
      return;
    }
    const sessionMatch = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(
      requestUrl.pathname,
    );
    if (method === "GET" && sessionMatch?.[1]) {
      retrieveCheckoutSession(
        outgoing,
        decodeURIComponent(sessionMatch[1]),
        state,
      );
      return;
    }

    writeStripeError(
      outgoing,
      404,
      "invalid_request_error",
      `Unrecognized request URL (${method}: ${requestUrl.pathname})`,
      "resource_missing",
    );
  } catch (error) {
    if (outgoing.destroyed) return;
    writeStripeError(
      outgoing,
      500,
      "api_error",
      error instanceof Error ? error.message : "Fake Stripe request failed",
    );
  }
}

function searchCustomers(
  outgoing: ServerResponse,
  query: URLSearchParams,
  state: MutableFakeStripeState,
): void {
  const search = query.get("query") ?? "";
  const metadataMatch = /metadata\[['"]([^'"]+)['"]\]\s*:\s*'([^']*)'/.exec(
    search,
  );
  const data = [...state.customers.values()]
    .filter(
      (customer) =>
        !metadataMatch ||
        customer.metadata[metadataMatch[1] ?? ""] === metadataMatch[2],
    )
    .sort(
      (left, right) =>
        right.created - left.created || right.id.localeCompare(left.id),
    );
  const limit = boundedLimit(query.get("limit"));
  writeJson(outgoing, 200, {
    object: "search_result",
    data: data.slice(0, limit),
    has_more: data.length > limit,
    next_page: data.length > limit ? "fake-next-page" : null,
    url: "/v1/customers/search",
  });
}

function createCustomer(
  outgoing: ServerResponse,
  form: URLSearchParams,
  fingerprint: string,
  headers: IncomingHttpHeaders,
  state: MutableFakeStripeState,
): void {
  state.counters.customerCreateAttempts += 1;
  const idempotencyKey = headerValue(headers["idempotency-key"]);
  const existing = idempotencyKey
    ? state.customerIdempotency.get(idempotencyKey)
    : undefined;
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      writeIdempotencyMismatch(outgoing);
      return;
    }
    writeJson(outgoing, 200, existing.value);
    return;
  }

  const customer: FakeStripeCustomer = {
    id: `cus_fake_${padId(state.nextCustomerId)}`,
    object: "customer",
    created: nowSeconds(),
    livemode: false,
    email: form.get("email"),
    name: form.get("name"),
    metadata: parseMetadata(form, "metadata"),
  };
  state.nextCustomerId += 1;
  state.customers.set(customer.id, customer);
  state.counters.customersCreated += 1;
  if (idempotencyKey) {
    state.customerIdempotency.set(idempotencyKey, {
      fingerprint,
      value: customer,
    });
  }
  writeJson(outgoing, 200, customer);
}

function retrieveCustomer(
  outgoing: ServerResponse,
  customerId: string,
  state: MutableFakeStripeState,
): void {
  const customer = state.customers.get(customerId);
  if (!customer) {
    writeStripeError(
      outgoing,
      404,
      "invalid_request_error",
      `No such customer: '${customerId}'`,
      "resource_missing",
      "id",
    );
    return;
  }
  writeJson(outgoing, 200, customer);
}

function createCheckoutSession(
  outgoing: ServerResponse,
  form: URLSearchParams,
  fingerprint: string,
  headers: IncomingHttpHeaders,
  state: MutableFakeStripeState,
): void {
  state.counters.checkoutSessionCreateAttempts += 1;
  const idempotencyKey = headerValue(headers["idempotency-key"]);
  const existing = idempotencyKey
    ? state.sessionIdempotency.get(idempotencyKey)
    : undefined;
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      writeIdempotencyMismatch(outgoing);
      return;
    }
    if (loseCheckoutResponseIfArmed(outgoing, idempotencyKey, state)) return;
    writeJson(outgoing, 200, existing.value);
    return;
  }

  const customer = form.get("customer");
  if (!customer || !state.customers.has(customer)) {
    writeStripeError(
      outgoing,
      400,
      "invalid_request_error",
      "No such customer",
      "resource_missing",
      "customer",
    );
    return;
  }
  const lineItems = parseLineItems(form);
  if (lineItems.length === 0) {
    writeStripeError(
      outgoing,
      400,
      "invalid_request_error",
      "At least one line item is required",
      undefined,
      "line_items",
    );
    return;
  }
  const currency = lineItems[0]?.currency;
  if (!currency || lineItems.some((item) => item.currency !== currency)) {
    writeStripeError(
      outgoing,
      400,
      "invalid_request_error",
      "Line item currencies must match",
      undefined,
      "line_items",
    );
    return;
  }

  const numericId = state.nextSessionId;
  const session: FakeStripeCheckoutSession = {
    id: `cs_test_fake_${padId(numericId)}`,
    object: "checkout.session",
    url: `https://checkout.stripe.test/c/pay/cs_test_fake_${padId(numericId)}`,
    customer,
    client_reference_id: form.get("client_reference_id"),
    metadata: parseMetadata(form, "metadata"),
    amount_total: lineItems.reduce(
      (total, item) => total + item.unitAmount * item.quantity,
      0,
    ),
    currency,
    payment_status: "unpaid",
    status: "open",
    payment_intent: null,
    created: nowSeconds(),
    livemode: false,
  };
  state.nextSessionId += 1;
  state.sessions.set(session.id, session);
  state.counters.checkoutSessionsCreated += 1;
  state.effects.push({
    kind: "checkout.session.create",
    id: session.id,
    idempotencyKey: idempotencyKey ?? null,
    committedAt: session.created,
  });
  if (idempotencyKey) {
    state.sessionIdempotency.set(idempotencyKey, {
      fingerprint,
      value: session,
    });
  }

  if (loseCheckoutResponseIfArmed(outgoing, idempotencyKey, state)) return;
  writeJson(outgoing, 200, session);
}

function loseCheckoutResponseIfArmed(
  outgoing: ServerResponse,
  idempotencyKey: string | undefined,
  state: MutableFakeStripeState,
): boolean {
  if (state.checkoutResponseLossesRemaining <= 0) return false;
  const targetKey = idempotencyKey ?? "<missing-idempotency-key>";
  state.checkoutResponseLossTargetKey ??= targetKey;
  if (state.checkoutResponseLossTargetKey !== targetKey) return false;

  state.checkoutResponseLossesRemaining -= 1;
  state.counters.checkoutSessionCreateResponsesLost += 1;
  if (state.checkoutResponseLossesRemaining === 0) {
    state.checkoutResponseLossTargetKey = null;
  }
  const socket = outgoing.socket;
  outgoing.destroy();
  socket?.destroy();
  return true;
}

function listCheckoutSessions(
  outgoing: ServerResponse,
  query: URLSearchParams,
  state: MutableFakeStripeState,
): void {
  const customer = query.get("customer");
  const createdGte = parseOptionalInteger(query.get("created[gte]"));
  const createdLte = parseOptionalInteger(query.get("created[lte]"));
  const startingAfter = query.get("starting_after");
  const ordered = [...state.sessions.values()]
    .filter((session) => !customer || session.customer === customer)
    .filter((session) => createdGte === null || session.created >= createdGte)
    .filter((session) => createdLte === null || session.created <= createdLte)
    .sort(
      (left, right) =>
        right.created - left.created || right.id.localeCompare(left.id),
    );
  const startIndex = startingAfter
    ? Math.max(
        ordered.findIndex((session) => session.id === startingAfter) + 1,
        0,
      )
    : 0;
  const limit = boundedLimit(query.get("limit"));
  const data = ordered.slice(startIndex, startIndex + limit);
  writeJson(outgoing, 200, {
    object: "list",
    data,
    has_more: startIndex + data.length < ordered.length,
    url: "/v1/checkout/sessions",
  });
}

function retrieveCheckoutSession(
  outgoing: ServerResponse,
  sessionId: string,
  state: MutableFakeStripeState,
): void {
  const session = state.sessions.get(sessionId);
  if (!session) {
    writeStripeError(
      outgoing,
      404,
      "invalid_request_error",
      `No such checkout.session: '${sessionId}'`,
      "resource_missing",
    );
    return;
  }
  writeJson(outgoing, 200, session);
}

function parseMetadata(
  form: URLSearchParams,
  prefix: string,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\[([^\\]]+)\\]$`);
  for (const [key, value] of form) {
    const match = pattern.exec(key);
    if (match?.[1]) metadata[match[1]] = value;
  }
  return metadata;
}

function parseLineItems(form: URLSearchParams): Array<{
  index: number;
  unitAmount: number;
  quantity: number;
  currency: string;
}> {
  const byIndex = new Map<
    number,
    { unitAmount?: number; quantity?: number; currency?: string }
  >();
  for (const [key, value] of form) {
    const match =
      /^line_items\[(\d+)\]\[(?:price_data\]\[(unit_amount|currency)|(quantity))\]$/.exec(
        key,
      );
    if (!match?.[1]) continue;
    const index = Number(match[1]);
    const item = byIndex.get(index) ?? {};
    const field = match[2] ?? match[3];
    if (field === "unit_amount") item.unitAmount = Number(value);
    else if (field === "quantity") item.quantity = Number(value);
    else if (field === "currency") item.currency = value.toLowerCase();
    byIndex.set(index, item);
  }
  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([index, item]) => {
      const unitAmount = item.unitAmount;
      const currency = item.currency;
      if (
        unitAmount === undefined ||
        !Number.isSafeInteger(unitAmount) ||
        unitAmount < 0 ||
        !Number.isSafeInteger(item.quantity ?? 1) ||
        (item.quantity ?? 1) <= 0 ||
        !currency
      ) {
        return [];
      }
      return [
        {
          index,
          unitAmount,
          quantity: item.quantity ?? 1,
          currency,
        },
      ];
    });
}

function collectParams(params: URLSearchParams): Record<string, string[]> {
  const collected: Record<string, string[]> = {};
  for (const [key, value] of params) {
    const values = collected[key] ?? [];
    values.push(value);
    collected[key] = values;
  }
  return collected;
}

function inspectableHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "idempotency-key", "stripe-version"]) {
    const value = headerValue(headers[name]);
    if (value) result[name] = value;
  }
  return result;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hasBearerAuthorization(value: string | undefined): boolean {
  return /^Bearer\s+\S+$/.test(value ?? "");
}

function boundedLimit(raw: string | null): number {
  const parsed = Number(raw ?? 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 100)
    : 10;
}

function parseOptionalInteger(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function padId(id: number): string {
  return String(id).padStart(6, "0");
}

function paymentIntentId(sessionId: string): string {
  return sessionId.replace(/^cs_test_/, "pi_");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeIdempotencyMismatch(outgoing: ServerResponse): void {
  writeStripeError(
    outgoing,
    400,
    "idempotency_error",
    "Keys for idempotent requests can only be used with the same parameters",
  );
}

function writeStripeError(
  outgoing: ServerResponse,
  status: number,
  type: string,
  message: string,
  code?: string,
  param?: string,
): void {
  writeJson(outgoing, status, {
    error: {
      type,
      message,
      ...(code ? { code } : {}),
      ...(param ? { param } : {}),
    },
  });
}

function writeJson(
  outgoing: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  outgoing.statusCode = status;
  outgoing.setHeader("content-type", "application/json");
  outgoing.setHeader("content-length", Buffer.byteLength(body));
  outgoing.setHeader("request-id", `req_fake_${Date.now()}`);
  outgoing.end(body);
}

async function readBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function closeServer(
  server: ReturnType<typeof createServer>,
  sockets: Set<Socket>,
): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    for (const socket of sockets) socket.destroy();
  });
}
