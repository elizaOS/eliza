/** Reports current Cloud connection and the runtime-owned application billing selection. */
import { fetchCloudCredits } from "../lib/cloud-connection";
import { isElizaCloudServiceSelectedInConfig } from "@elizaos/core/contracts/cloud-topology";
import { nativeBillingSelection } from "./native-billing-selection";
import { resolveCloudBillingUrl } from "../cloud/base-url.js";
import { resolveCloudConnectionSnapshot } from "../lib/cloud-connection";
import { type CloudConfigLike } from "./cloud-status-routes-autonomous.js";
import { type CloudStatusRouteContext } from "./cloud-status-routes-autonomous.js";
import { type ElizaConfig } from "../lib/config-like";
export type { CloudConfigLike, CloudStatusRouteContext };
export async function handleCloudStatusRoutes(ctx: CloudStatusRouteContext): Promise<boolean> {
    const { res, method, pathname, config, runtime, json } = ctx;
    const typedConfig = config as ElizaConfig;
    const topUpUrl = resolveCloudBillingUrl(typedConfig.cloud?.baseUrl);
    if (method === "GET" && pathname === "/api/cloud/status") {
        const applicationBilling = nativeBillingSelection(runtime);
        const snapshot = resolveCloudConnectionSnapshot(typedConfig, runtime);
        const cloudVoiceProxyAvailable = isElizaCloudServiceSelectedInConfig(typedConfig as Record<string, unknown>, "tts");
        if (snapshot.connected) {
            json(res, {
                applicationBilling,
                connected: true,
                enabled: snapshot.enabled,
                cloudVoiceProxyAvailable,
                hasApiKey: snapshot.hasApiKey,
                userId: snapshot.userId,
                organizationId: snapshot.organizationId,
                topUpUrl,
                reason: snapshot.authConnected
                    ? undefined
                    : runtime
                        ? "api_key_present_not_authenticated"
                        : "api_key_present_runtime_not_started",
            });
            return true;
        }
        if (!runtime) {
            json(res, {
                applicationBilling,
                connected: false,
                enabled: snapshot.enabled,
                cloudVoiceProxyAvailable,
                hasApiKey: snapshot.hasApiKey,
                reason: "runtime_not_started",
            });
            return true;
        }
        json(res, {
            applicationBilling,
            connected: false,
            enabled: snapshot.enabled,
            cloudVoiceProxyAvailable,
            hasApiKey: snapshot.hasApiKey,
            reason: "not_authenticated",
        });
        return true;
    }
    if (method === "GET" && pathname === "/api/cloud/credits") {
        json(res, await fetchCloudCredits(typedConfig, runtime));
        return true;
    }
    return false;
}
