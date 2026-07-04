/**
 * XR views route lists registered XR-capable plugin views for the headset view
 * launcher and pushes the catalog to active sessions.
 */
import { listViews } from "@elizaos/agent/api/views-registry";
import type { Route } from "@elizaos/core";
import {
	XR_SERVICE_TYPE,
	type XRSessionService,
} from "../services/xr-session-service.ts";

export const viewsRoute: Route = {
	type: "GET",
	path: "/xr/views",
	description: "Lists all XR-capable views from registered plugins",
	routeHandler: async (ctx) => {
		const views = listViews({ developerMode: true, viewType: "xr" })
			.filter((v) => v.viewType === "xr")
			.map((v) => ({
				id: v.id,
				label: v.label,
				icon: v.icon,
				description: v.description,
				tags: v.tags,
				xrOptions: v.xrOptions,
				path: v.path,
				pluginName: v.pluginName,
				available: v.available,
			}));

		const connections =
			ctx.runtime
				.getService<XRSessionService>(XR_SERVICE_TYPE)
				?.getConnections()
				.map((c) => ({ id: c.id, deviceType: c.deviceType })) ?? [];

		return {
			status: 200,
			body: { views, connections, count: views.length },
		};
	},
};
