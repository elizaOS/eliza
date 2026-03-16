/**
 * @module plugin-webhooks
 * @description elizaOS plugin for HTTP webhook ingress.
 *
 * Exposes three route groups via the plugin `routes` array:
 *   POST /hooks/wake      - Enqueue system event + optional immediate heartbeat
 *   POST /hooks/agent     - Run isolated agent turn + optional delivery
 *   POST /hooks/:name     - Mapped webhook (resolves via hooks.mappings config)
 *
 * No separate HTTP server is created – routes register on the runtime's
 * existing HTTP server via the Eliza plugin system.
 *
 * Cross-plugin communication:
 *   Emits HEARTBEAT_WAKE and HEARTBEAT_SYSTEM_EVENT events which are
 *   consumed by @elizaos/plugin-cron's heartbeat worker.
 *
 * @example Config (character.settings):
 * ```json5
 * {
 *   hooks: {
 *     enabled: true,
 *     token: "shared-secret",
 *     presets: ["gmail"],
 *     mappings: [
 *       {
 *         match: { path: "github" },
 *         action: "agent",
 *         name: "GitHub",
 *         messageTemplate: "New event: {{action}} on {{repository.full_name}}",
 *         wakeMode: "now",
 *         deliver: true,
 *         channel: "discord",
 *         to: "channel:123456789",
 *       }
 *     ],
 *   }
 * }
 * ```
 */

import type { Plugin, Route } from '@elizaos/core';
import { handleWake, handleAgent, handleMapped } from './handlers.js';

export { validateToken, extractToken } from './auth.js';
export { findMapping, applyMapping, renderTemplate, type HookMapping } from './mappings.js';

export const webhooksPlugin: Plugin = {
  name: 'webhooks',
  description: 'HTTP webhook ingress for external triggers',

  routes: [
    {
      type: 'POST',
      path: '/hooks/wake',
      handler: handleWake as Route['handler'],
    },
    {
      type: 'POST',
      path: '/hooks/agent',
      handler: handleAgent as Route['handler'],
    },
    {
      type: 'POST',
      path: '/hooks/:name',
      handler: handleMapped as Route['handler'],
    },
  ],
};

export default webhooksPlugin;
