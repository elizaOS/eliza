/**
 * Cloud N8N Plugin — wraps @elizaos/plugin-n8n-workflow with the credential bridge.
 *
 * Loaded only when the character's plugins array includes "@elizaos/plugin-n8n-workflow".
 * Bundles the external plugin (actions, providers, services, schema) with
 * N8nCredentialBridge so credentials are resolved through cloud OAuth / API keys.
 */

import type { Plugin } from "@elizaos/core";
import { n8nWorkflowPlugin } from "@elizaos/plugin-n8n-workflow";
import { N8nCredentialBridge } from "../plugin-n8n-bridge";

export const cloudN8nPlugin: Plugin = {
  ...n8nWorkflowPlugin,
  name: "cloud-n8n-workflow",
  services: [...(n8nWorkflowPlugin.services || []), N8nCredentialBridge],
};
