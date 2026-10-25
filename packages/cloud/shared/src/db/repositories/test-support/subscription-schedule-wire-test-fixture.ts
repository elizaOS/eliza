/** Actual Stripe SDK over loopback; captures request fields, never credentials. */
import { createServer } from "node:http";
import Stripe from "stripe";

export interface ScheduleWireRequest {
  method: string;
  path: string;
  body: URLSearchParams;
  idempotencyKey: string | undefined;
  apiVersion: string | undefined;
}
export async function startScheduleWireFixture(
  handle: (request: ScheduleWireRequest) => Promise<unknown>,
) {
  const requests: ScheduleWireRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const item: ScheduleWireRequest = {
        method: request.method ?? "",
        path: request.url ?? "",
        body: new URLSearchParams(body),
        idempotencyKey:
          typeof request.headers["idempotency-key"] === "string"
            ? request.headers["idempotency-key"]
            : undefined,
        apiVersion:
          typeof request.headers["stripe-version"] === "string"
            ? request.headers["stripe-version"]
            : undefined,
      };
      requests.push(item);
      response.setHeader("Content-Type", "application/json");
      void handle(item).then(
        (value) => response.end(JSON.stringify(value)),
        () => {
          // error-policy:J1 Simulate a failed/lost accepted provider response without exposing data.
          response.statusCode = 500;
          response.setHeader("Stripe-Should-Retry", "true");
          response.end(
            JSON.stringify({
              error: { type: "api_error", message: "Controlled response unavailable" },
            }),
          );
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing loopback address");
  const stripe = new Stripe("sk_test_schedule_wire_fixture", {
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
    maxNetworkRetries: 2,
    // The integration validates the retained Acacia wire contract, independent of SDK type evolution.
    apiVersion: "2024-11-20.acacia" as Stripe.StripeConfig["apiVersion"],
  });
  return {
    stripe,
    requests,
    async close() {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
