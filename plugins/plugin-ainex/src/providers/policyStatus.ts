import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { AinexService } from "../service";

function _disconnectedResult(): ProviderResult {
  return {
    text: "(ainex not connected)",
    values: { ainexConnected: false },
    data: {},
  };
}

export const policyStatusProvider: Provider = {
  name: "AINEX_POLICY_STATUS",
  description:
    "Active learned-policy / VLA / RL skill lifecycle status reported by the bridge.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<AinexService>(AinexService.serviceType);
    if (!service || !service.isConnected()) {
      return _disconnectedResult();
    }
    const policy = service.getPolicyStatus();
    if (!policy || policy.state === "" || policy.state === "idle") {
      return {
        text: "AiNex policy: idle (no active learned skill).",
        values: { ainexConnected: true, policyActive: false },
        data: {},
      };
    }
    const target = policy.target_label
      ? ` target=${policy.target_label}`
      : "";
    return {
      text: `AiNex policy: state=${policy.state} task=${policy.task} step=${policy.step}${target}`,
      values: {
        ainexConnected: true,
        policyActive: policy.state === "running",
        policyTask: policy.task,
        policyStep: policy.step,
      },
      data: { policy },
    };
  },
};
