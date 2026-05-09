/**
 * Cloud N8N Plugin — wraps @elizaos/plugin-workflow with the credential bridge.
 *
 * Loaded only when the character's plugins array includes "@elizaos/plugin-workflow".
 * Bundles the external plugin (actions, providers, services, schema) with
 * WorkflowCredentialBridge so credentials are resolved through cloud OAuth / API keys.
 */

import type { Plugin } from "@elizaos/core";
import { workflowPlugin } from "@elizaos/plugin-workflow";
import { WorkflowCredentialBridge } from "../plugin-n8n-bridge";

export const cloudN8nPlugin: Plugin = {
  ...workflowPlugin,
  name: "cloud-n8n-workflow",
  services: [...(workflowPlugin.services || []), WorkflowCredentialBridge],
};
