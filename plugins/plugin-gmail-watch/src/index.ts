/**
 * @module plugin-gmail-watch
 * @description elizaOS plugin for Gmail Pub/Sub push watcher.
 *
 * This plugin manages the `gog gmail watch serve` child process that:
 *   1. Receives Google Pub/Sub push notifications for new emails
 *   2. Fetches message content via the Gmail API
 *   3. Forwards structured payloads to the webhooks plugin (/hooks/gmail)
 *   4. Auto-renews the Gmail watch periodically
 *
 * Prerequisites:
 *   - gog CLI installed and authorized for the Gmail account
 *   - Google Cloud Pub/Sub topic + subscription configured
 *   - hooks.enabled=true and hooks.gmail.account set in config
 *
 * The plugin-webhooks plugin handles the /hooks/gmail endpoint.
 * Configure hooks.presets: ["gmail"] to enable the built-in Gmail mapping.
 *
 * @example Config (character.settings):
 * ```json5
 * {
 *   hooks: {
 *     enabled: true,
 *     token: "shared-secret",
 *     presets: ["gmail"],
 *     gmail: {
 *       account: "user@gmail.com",
 *       label: "INBOX",
 *       topic: "projects/my-project/topics/gog-gmail-watch",
 *       includeBody: true,
 *       maxBytes: 20000,
 *       renewEveryMinutes: 360,
 *       serve: { bind: "127.0.0.1", port: 8788, path: "/gmail-pubsub" },
 *     },
 *   },
 * }
 * ```
 */

import type { Plugin } from '@elizaos/core';
import { GmailWatchService } from './service.js';

export { GmailWatchService } from './service.js';
export type { GmailWatchConfig } from './service.js';

export const gmailWatchPlugin: Plugin = {
  name: 'gmail-watch',
  description: 'Gmail Pub/Sub push watcher – spawns gog gmail watch serve',

  services: [GmailWatchService],
};

export default gmailWatchPlugin;
