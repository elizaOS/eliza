/**
 * Exposes the production admission Durable Object through a minimal Worker so
 * Miniflare can exercise Cloudflare storage, serialization, and routing.
 */

import { InferenceAdmissionGate } from "../../src/inference-admission-gate";

export class TestInferenceAdmissionGate extends InferenceAdmissionGate {
  private readonly testState: DurableObjectState;

  constructor(state: DurableObjectState, env: Record<string, unknown>) {
    super(state, env as never);
    this.testState = state;
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/test-block-ledger") {
      return await super.fetch(request);
    }
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = this.testState.storage.transaction(async (transaction) => {
      await transaction.put("test-ledger-block", Date.now());
      entered();
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    });
    this.testState.waitUntil(blocked);
    await started;
    return new Response(null, { status: 202 });
  }
}

export default {
  async fetch(
    request: Request,
    env: { INFERENCE_ADMISSION_GATES: DurableObjectNamespace },
  ) {
    const organizationId = request.headers.get("x-test-organization-id");
    if (!organizationId)
      return new Response("missing organization", { status: 400 });
    const gateName = request.headers.get("x-test-gate-name") ?? organizationId;
    return await env.INFERENCE_ADMISSION_GATES.get(
      env.INFERENCE_ADMISSION_GATES.idFromName(gateName),
    ).fetch(request);
  },
};
