/** Real caller and SQLite actor; only dispatch readiness and inspection are test-owned. */
import "../../src/worker-polyfills";

export * from "../../src/index";

import { runWithCloudBindingsAsync } from "../../../shared/src/lib/runtime/cloud-bindings";
import {
  consumeInferenceRateLimit,
  InferenceAdmissionGateUnavailableError,
} from "../../../shared/src/lib/services/inference-admission-gate";
import { InferenceAdmissionGate } from "../../src/inference-admission-gate";

interface TestEnv {
  INFERENCE_ADMISSION_GATES: DurableObjectNamespace;
  TEST_INPUT_DELAY_MS: string;
}

export class DelayedInferenceAdmissionGate extends InferenceAdmissionGate {
  private readonly testState: DurableObjectState;
  private readonly requests: Record<string, unknown>[] = [];

  constructor(state: DurableObjectState, env: TestEnv) {
    super(state, env as never);
    this.testState = state;
    // This artificial input gate reproduces dispatch delay, not a production
    // constructor defect. The rate handler and durable counters stay unchanged.
    state.blockConcurrencyWhile(async () => {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Number(env.TEST_INPUT_DELAY_MS)),
      );
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/test-inspect") {
      return Response.json({
        requests: this.requests,
        counters: this.testState.storage.kv.get("rate-limits") ?? null,
      });
    }
    this.requests.push(
      (await request.clone().json()) as Record<string, unknown>,
    );
    return await super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const organizationId = request.headers.get("x-test-organization-id");
    if (!organizationId) return new Response(null, { status: 400 });
    const path = new URL(request.url).pathname;
    if (path !== "/consume") {
      const stub = env.INFERENCE_ADMISSION_GATES.getByName(
        `rate-limit:v2:${organizationId}`,
      );
      return await stub.fetch(
        new Request(`https://gate.test${path}`, {
          method: request.method,
          headers: request.headers,
          body: await request.arrayBuffer(),
        }),
      );
    }
    return await runWithCloudBindingsAsync(
      env as unknown as Record<string, unknown>,
      async () => {
        try {
          return Response.json(
            await consumeInferenceRateLimit({
              organizationId,
              endpointType: "completions",
              windowMs: 60_000,
              maxRequests: 2,
              apiKey: { id: "test-key", maxRequests: 2 },
            }),
          );
        } catch (error) {
          if (error instanceof InferenceAdmissionGateUnavailableError) {
            return Response.json({ error: error.name }, { status: 503 });
          }
          throw error;
        }
      },
    );
  },
};
