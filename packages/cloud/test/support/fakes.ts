// spec/cloud/deployment.md, "Story: Configure a deployment from one reviewed profile"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

export interface FakeAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type FakeHandler = (request: FakeRequest) => FakeAnswer | undefined | Promise<FakeAnswer | undefined>;

export interface FakeServer {
  readonly url: string;
  readonly seen: FakeRequest[];
  mount(prefix: `/${string}`, handler: FakeHandler): void;
  close(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, answer: FakeAnswer): void {
  const text = answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
  response.writeHead(answer.status, { "content-type": typeof answer.body === "string" ? "text/plain" : "application/json", ...answer.headers });
  response.end(text);
}

export async function startFakeServer(): Promise<FakeServer> {
  const mounts: Array<{ prefix: string; handler: FakeHandler }> = [];
  const seen: FakeRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake.invalid");
      const fake: FakeRequest = { method: request.method ?? "GET", path: url.pathname, query: url.searchParams, headers: request.headers, body: await bodyOf(request) };
      seen.push(fake);
      for (const { prefix, handler } of mounts) {
        if (!fake.path.startsWith(prefix)) continue;
        const answer = await handler({ ...fake, path: fake.path.slice(prefix.length - 1) });
        if (answer !== undefined) return send(response, answer);
      }
      send(response, { status: 404, body: { error: { type: "invalid_request_error", message: `no fake for ${fake.method} ${fake.path}` } } });
    })().catch((cause: unknown) => send(response, { status: 500, body: { error: String(cause) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    mount: (prefix, handler) => { mounts.push({ prefix, handler }); },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export interface CatalogPrice {
  readonly priceId: string;
  readonly productId: string;
  readonly unitAmount: number;
  readonly livemode?: boolean;
}

export function stripeCatalog(prices: ReadonlyArray<CatalogPrice>): FakeHandler {
  return (request) => {
    if (request.headers.authorization !== "Bearer sk_test_fake") return { status: 401, body: { error: { type: "invalid_request_error" } } };
    const price = prices.find((candidate) => request.path === `/v1/prices/${candidate.priceId}`);
    if (price !== undefined) {
      return {
        status: 200,
        body: {
          id: price.priceId,
          object: "price",
          active: true,
          currency: "usd",
          unit_amount: price.unitAmount,
          type: "recurring",
          billing_scheme: "per_unit",
          transform_quantity: null,
          livemode: price.livemode ?? false,
          product: price.productId,
          recurring: { interval: "month", interval_count: 1, trial_period_days: null, usage_type: "licensed" },
        },
      };
    }
    const product = prices.find((candidate) => request.path === `/v1/products/${candidate.productId}`);
    if (product !== undefined) return { status: 200, body: { id: product.productId, object: "product", active: true, livemode: product.livemode ?? false } };
    return undefined;
  };
}
