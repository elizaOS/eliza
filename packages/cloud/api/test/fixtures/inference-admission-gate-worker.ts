/**
 * Exposes the production admission Durable Object through a minimal Worker so
 * Miniflare can exercise Cloudflare storage, serialization, and routing.
 */

import { InferenceAdmissionGate } from "../../src/inference-admission-gate";

export { InferenceAdmissionGate };

export default {
  async fetch(
    request: Request,
    env: { TEST_ADMISSION_GATE: DurableObjectNamespace },
  ) {
    const organizationId = request.headers.get("x-test-organization-id");
    if (!organizationId)
      return new Response("missing organization", { status: 400 });
    return await env.TEST_ADMISSION_GATE.get(
      env.TEST_ADMISSION_GATE.idFromName(organizationId),
    ).fetch(request);
  },
};
