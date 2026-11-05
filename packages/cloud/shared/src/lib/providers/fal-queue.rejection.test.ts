/**
 * A fal queue submit that fails with a 4xx creates no job and bills nothing.
 * The error keeps the status so the route's billing classifier releases the
 * hold instead of charging the quoted price.
 */
import { APICallError } from "ai";
import { expect, it } from "vitest";
import { isKnownUnacceptedProviderError } from "../services/inference-provider-outcome";
import { runFalQueueJob } from "./fal-queue";

async function submitFailure(status: number) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ detail: "prompt rejected" }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return runFalQueueJob(
    "fal-ai/minimax-music/v2.6",
    { prompt: "x" },
    { apiKey: "test", pollIntervalMs: 1, timeoutMs: 10 },
    fetchImpl,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
}

it("reports a fal submit rejection as a provider refusal with its status", async () => {
  const error = await submitFailure(422);
  expect({
    apiCallError: APICallError.isInstance(error),
    statusCode: (error as { statusCode?: number }).statusCode,
    message: (error as Error).message,
    released: isKnownUnacceptedProviderError(error),
  }).toEqual({
    apiCallError: true,
    statusCode: 422,
    message: "fal queue submit failed (422): prompt rejected",
    released: true,
  });
});

it("keeps a fal 5xx on submit as an ambiguous failure", async () => {
  const error = await submitFailure(503);
  expect({
    statusCode: (error as { statusCode?: number }).statusCode,
    released: isKnownUnacceptedProviderError(error),
  }).toEqual({ statusCode: 503, released: false });
});
