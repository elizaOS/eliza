/** Real API RPC entrypoint; only the primary database boundary is scripted. */
import { InferenceRecoveryService } from "../../src/inference-recovery-service";

interface PrimaryState {
  policy: unknown;
  mutation: unknown;
  mode: string;
  policyReads: number;
  mutationReads: number;
}

export class PolicyPrimaryFixture extends InferenceRecoveryService {
  configure(input: Partial<PrimaryState>) {
    const state = globalThis as { __policyRpcFixture?: PrimaryState };
    state.__policyRpcFixture ??= {
      policy: null,
      mutation: { state: "absent" },
      mode: "ok",
      policyReads: 0,
      mutationReads: 0,
    };
    Object.assign(state.__policyRpcFixture, input);
  }

  stats() {
    const state = (globalThis as { __policyRpcFixture?: PrimaryState })
      .__policyRpcFixture;
    return {
      policyReads: state?.policyReads ?? 0,
      mutationReads: state?.mutationReads ?? 0,
    };
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
