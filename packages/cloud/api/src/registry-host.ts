/**
 * Returns an explicit retirement notice on the former community registry hosts.
 * Other hosts fall through to the normal Worker router; no artifact is fetched.
 */
import { ELIZA_SERVICE_DOMAIN_CONTRACTS } from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";
import { type AppEnv } from "@/types/cloud-worker-env";
type RegistryHostBindings = Pick<AppEnv["Bindings"], "ELIZA_CLOUD_AGENT_BASE_DOMAIN">;
export async function serveRegistryHostRequest(request: Request, url: URL, env: RegistryHostBindings): Promise<Response | null> {
    const environment = env.ELIZA_CLOUD_AGENT_BASE_DOMAIN?.includes("staging")
        ? "staging"
        : "production";
    const hostname = new URL(ELIZA_SERVICE_DOMAIN_CONTRACTS[environment].pluginRegistryOrigin).hostname;
    if (url.hostname.toLowerCase() !== hostname)
        return null;
    const body = JSON.stringify({
        success: false,
        code: "registry_retired",
        error: "The community plugin registry is retired. elizaOS no longer accepts third-party plugins or registry items.",
    });
    return new Response(request.method === "HEAD" ? null : body, {
        status: 410,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
            "access-control-allow-origin": "*",
            "x-content-type-options": "nosniff",
        },
    });
}
