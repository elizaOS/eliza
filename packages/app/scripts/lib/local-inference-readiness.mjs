// Pure readiness predicate for the mobile-local-chat-smoke full-turn gate.
// Extracted from mobile-local-chat-smoke.mjs so the decision is unit-testable
// (#11498). Takes the raw JSON snapshots from the three local-inference status
// endpoints and decides whether a full turn can be served, and via which path.
//
// Ready when ANY of:
//   1. hub.active.status === "ready"            (desktop/hub-activated model)
//   2. device.connected && device.modelPath      (paired cross-process device)
//   3. capacitor-llama provider servingVia === "bionic-host"
//      (Android in-process GPU host: handlers bound via bionic-host AND the
//      host socket accepts connections — surfaced by
//      GET /api/local-inference/providers)
//
// hub.active.status === "error" is a hard failure, not "keep polling".

/**
 * @param {{ hub?: object|null, device?: object|null, providers?: object|null }} snapshot
 * @returns {{ ready: boolean, via: "hub-active"|"device-bridge"|"bionic-host"|null, error: string|null }}
 */
export function evaluateLocalInferenceReadiness({ hub, device, providers }) {
  const activeStatus = String(hub?.active?.status ?? "");
  if (activeStatus === "error") {
    const activeError = String(hub?.active?.error ?? "");
    return {
      ready: false,
      via: null,
      error: `Local inference hub is in error state: ${activeError || "unknown"}`,
    };
  }

  if (activeStatus === "ready") {
    return { ready: true, via: "hub-active", error: null };
  }

  const deviceConnected = device?.connected === true;
  const deviceModelPath =
    typeof device?.modelPath === "string" && device.modelPath.trim().length > 0;
  if (deviceConnected && deviceModelPath) {
    return { ready: true, via: "device-bridge", error: null };
  }

  const providerList = Array.isArray(providers?.providers)
    ? providers.providers
    : [];
  const capacitorLlama = providerList.find(
    (provider) => provider?.id === "capacitor-llama",
  );
  if (capacitorLlama?.servingVia === "bionic-host") {
    return { ready: true, via: "bionic-host", error: null };
  }

  return { ready: false, via: null, error: null };
}
