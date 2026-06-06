/**
 * Plugin-route registration for the voice-profile HTTP surface (issue #8234).
 *
 * `handleVoiceSpeakerProfileRoutes` (bind/unbind a recognized voice to an
 * elizaOS entity) and `handleVoiceProfilesManagementRoutes` (the server half
 * of the `VoiceProfileSection` management UI) are prefix dispatchers, but the
 * only server mount of `handleLocalInferenceRoutes` is gated behind
 * `/api/local-inference*` path prefixes — so neither the `/v1/voice/
 * speaker-profiles` nor the `/api/voice/profiles` namespace was reachable
 * over HTTP. Registering them as `rawPath` routes on the plugin object puts
 * them on `runtime.routes`, which both the upstream agent server and the
 * app-core dashboard server dispatch.
 *
 * Every route is private: the host dispatcher answers 401 for
 * unauthenticated callers before the handler runs.
 */

import type * as http from "node:http";
import { type Route, sendJsonError } from "@elizaos/core";

type VoicePrefixHandler = (
	req: http.IncomingMessage,
	res: http.ServerResponse,
) => Promise<boolean>;

/**
 * Adapt a boolean-returning prefix dispatcher to the plugin-route handler
 * contract. The route table below only registers paths the dispatcher owns,
 * so a `false` return means the request was shaped wrong (e.g. an invalid
 * profile id segment) — answer 404 rather than hanging the response.
 */
function delegate(load: () => Promise<VoicePrefixHandler>) {
	return async (req: unknown, res: unknown): Promise<void> => {
		const httpReq = req as http.IncomingMessage;
		const httpRes = res as http.ServerResponse;
		const handler = await load();
		const handled = await handler(httpReq, httpRes);
		if (!handled && !httpRes.headersSent) {
			sendJsonError(httpRes, "not found", 404);
		}
	};
}

const speakerProfiles = delegate(
	async () =>
		(await import("./voice-speaker-profile-routes.js"))
			.handleVoiceSpeakerProfileRoutes,
);

const profilesManagement = delegate(
	async () =>
		(await import("./voice-profiles-management-routes.js"))
			.handleVoiceProfilesManagementRoutes,
);

export const voiceProfilePluginRoutes: Route[] = [
	// Recognized-speaker centroids → elizaOS entity binding.
	{
		type: "GET",
		path: "/v1/voice/speaker-profiles",
		rawPath: true,
		handler: speakerProfiles,
	},
	{
		type: "POST",
		path: "/v1/voice/speaker-profiles/:id/bind",
		rawPath: true,
		handler: speakerProfiles,
	},
	{
		type: "POST",
		path: "/v1/voice/speaker-profiles/:id/unbind",
		rawPath: true,
		handler: speakerProfiles,
	},
	// VoiceProfileSection management UI (list / edit / merge / split / export /
	// sample preview / bind / unbind).
	{
		type: "GET",
		path: "/api/voice/profiles",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "DELETE",
		path: "/api/voice/profiles",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "POST",
		path: "/api/voice/profiles/export",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "PATCH",
		path: "/api/voice/profiles/:id",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "DELETE",
		path: "/api/voice/profiles/:id",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "GET",
		path: "/api/voice/profiles/:id/sample",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "POST",
		path: "/api/voice/profiles/:id/merge",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "POST",
		path: "/api/voice/profiles/:id/split",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "POST",
		path: "/api/voice/profiles/:id/bind",
		rawPath: true,
		handler: profilesManagement,
	},
	{
		type: "POST",
		path: "/api/voice/profiles/:id/unbind",
		rawPath: true,
		handler: profilesManagement,
	},
];
