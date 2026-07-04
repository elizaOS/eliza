/**
 * Browser entry point.
 *
 * The Anthropic proxy is Node-only (uses node:http, node:https, node:fs,
 * node:crypto) so the browser export is an unavailable entry. Loading the plugin in
 * a browser context will register an empty Plugin object that doesn't try to
 * start a server.
 */

import type { Plugin } from "@elizaos/core";

const anthropicProxyPluginBrowserUnavailable: Plugin = {
  name: "anthropic-proxy",
  description: "Anthropic proxy (unavailable in browser; only functional in Node environments)",
  services: [],
  actions: [],
  providers: [],
  routes: [],
  tests: [],
  init: async () => {
    /* unavailable in browser */
  },
};

export default anthropicProxyPluginBrowserUnavailable;
