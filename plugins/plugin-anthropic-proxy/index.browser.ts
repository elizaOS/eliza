/**
 * Browser entry point.
 *
 * The Anthropic proxy is Node-only (uses node:http, node:https, node:fs,
 * node:crypto) so the browser export is an inert compatibility plugin. Loading
 * the plugin in a browser context registers an empty Plugin object that never
 * tries to start a server.
 */

import type { Plugin } from "@elizaos/core";

const anthropicProxyPluginBrowserNoop: Plugin = {
  name: "anthropic-proxy",
  description:
    "Anthropic proxy (inert browser compatibility export; functional in Node environments)",
  services: [],
  actions: [],
  providers: [],
  routes: [],
  tests: [],
  init: async () => {
    /* Browser compatibility export; no server lifecycle. */
  },
};

export default anthropicProxyPluginBrowserNoop;
