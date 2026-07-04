/**
 * GET /api/anthropic-proxy/status
 *
 * External health/diagnostic surface for the Anthropic proxy.
 */
import { ANTHROPIC_PROXY_SERVICE_NAME, } from "../services/proxy-service.js";
async function handleStatus(_req, res, runtime) {
    const service = runtime.getService(ANTHROPIC_PROXY_SERVICE_NAME);
    if (!service) {
        res.status(503).json({
            error: "AnthropicProxyService not loaded",
        });
        return;
    }
    const status = await service.getStatus();
    res.status(200).json({
        ...status,
        stats: status.stats
            ? {
                ...status.stats,
                credsPath: undefined,
                subscriptionType: undefined,
            }
            : null,
    });
}
export const anthropicProxyRoutes = [
    {
        type: "GET",
        path: "/api/anthropic-proxy/status",
        handler: handleStatus,
        rawPath: true,
    },
];
//# sourceMappingURL=status-route.js.map