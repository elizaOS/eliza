/**
 * Browser entry point.
 *
 * The Anthropic proxy is Node-only (uses node:http, node:https, node:fs,
 * node:crypto) so the browser export is a no-op stub. Loading the plugin in
 * a browser context will register an empty Plugin object that doesn't try to
 * start a server.
 */

import type { Plugin } from "@elizaos/core";

const anthropicProxyPluginBrowserNoop: Plugin = {
	name: "anthropic-proxy",
	description:
		"Anthropic proxy (no-op in browser; only functional in Node environments)",
	services: [],
	actions: [],
	providers: [],
	routes: [],
	tests: [],
	init: async () => {
		/* noop in browser */
	},
};

export default anthropicProxyPluginBrowserNoop;
