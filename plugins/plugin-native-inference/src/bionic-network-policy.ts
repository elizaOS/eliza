import { ElizaError } from "@elizaos/core";
import { requestBionicHost } from "./bionic-host-request.js";
import type { RawNetworkState } from "./model-catalog/network-policy.js";

/** No cached authorization: every admission reads the current Android capabilities. */
export async function probeBionicNetworkPolicy(
  socketName: string,
): Promise<RawNetworkState> {
  const response = await requestBionicHost(
    socketName,
    { op: "networkPolicy" },
    2_000,
  );
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== true ||
    !("state" in response)
  ) {
    throw new ElizaError("Android network policy is unavailable", {
      code: "NETWORK_POLICY_UNAVAILABLE",
    });
  }
  const state = response.state;
  if (
    typeof state !== "object" ||
    state === null ||
    !("source" in state) ||
    state.source !== "android-os" ||
    !("connectionType" in state) ||
    !("metered" in state) ||
    typeof state.connectionType !== "string" ||
    !["wifi", "ethernet", "cellular", "none", "unknown"].includes(
      state.connectionType,
    ) ||
    (state.metered !== null && typeof state.metered !== "boolean")
  ) {
    throw new ElizaError("Android returned malformed network policy state", {
      code: "NETWORK_POLICY_INVALID",
    });
  }
  return {
    connectionType: state.connectionType as RawNetworkState["connectionType"],
    metered: state.metered,
  };
}
