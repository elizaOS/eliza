/**
 * Real admission gate and policy controller. The primary is a scripted fake
 * (see the harness) that counts every call and can be armed to throw.
 */
import { InferenceAdmissionGate } from "../../src/inference-admission-gate";

interface FakePrimary {
  dbCalls: number;
  forbidden: boolean;
  policies: Record<string, unknown>;
  mutations: Record<string, unknown>;
  holdRate: boolean;
  rateEntered?: () => void;
  releaseRate?: () => void;
}

function primary(): FakePrimary {
  const global = globalThis as { __ratePolicyPrimary?: FakePrimary };
  global.__ratePolicyPrimary ??= {
    dbCalls: 0,
    forbidden: false,
    policies: {},
    mutations: {},
    holdRate: false,
  };
  return global.__ratePolicyPrimary;
}

export class RatePolicyTestGate extends InferenceAdmissionGate {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const state = primary();
    if (path === "/test/primary") {
      const body = (await request.json()) as Partial<FakePrimary> & {
        policy?: { organizationId: string };
        mutation?: { organizationId: string; mutationId: string };
      };
      if (body.forbidden !== undefined) state.forbidden = body.forbidden;
      if (body.holdRate !== undefined) state.holdRate = body.holdRate;
      if (body.policy) state.policies[body.policy.organizationId] = body.policy;
      if (body.mutation)
        state.mutations[
          `${body.mutation.organizationId}:${body.mutation.mutationId}`
        ] = body.mutation;
      return Response.json({ dbCalls: state.dbCalls });
    }
    if (path === "/test/rate-entered") {
      await request.arrayBuffer();
      return new Promise<Response>((resolve) => {
        state.rateEntered = () => resolve(new Response(null, { status: 204 }));
      });
    }
    if (path === "/test/release-rate") {
      await request.arrayBuffer();
      state.holdRate = false;
      state.releaseRate?.();
      return new Response(null, { status: 204 });
    }
    if (path === "/rate-limit" && state.holdRate) {
      const released = new Promise<void>((resolve) => {
        state.releaseRate = resolve;
      });
      state.rateEntered?.();
      await released;
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(
    request: Request,
    env: { INFERENCE_ADMISSION_GATES: DurableObjectNamespace },
  ) {
    const name = request.headers.get("x-test-gate-name");
    if (!name) return new Response("Missing test gate", { status: 400 });
    return env.INFERENCE_ADMISSION_GATES.get(
      env.INFERENCE_ADMISSION_GATES.idFromName(name),
    ).fetch(request);
  },
};
