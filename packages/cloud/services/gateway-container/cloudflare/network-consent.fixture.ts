import {
  handleNetworkConsent,
  networkConsentOwner,
} from "./network-consent-state";

export { NetworkConsentState } from "./network-consent-state";
export default {
  fetch(
    request: Request,
    env: { NETWORK_CONSENT_STATE: DurableObjectNamespace },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/private") {
      return env.NETWORK_CONSENT_STATE.getByName(
        networkConsentOwner("project", "person"),
      ).fetch(request);
    }
    return handleNetworkConsent(request, {
      ...env,
      GATEWAY_KIND: "webhook",
      GATEWAY_RUNTIME_CONFIG: JSON.stringify({
        CLOUD_NETWORK_CONSENT_BACKEND: "cloudflare",
        NETWORK_CONSENT_TOKEN: "test-only",
      }),
    });
  },
};
