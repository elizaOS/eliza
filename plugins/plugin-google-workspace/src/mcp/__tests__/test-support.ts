/**
 * Shared deterministic harnesses for Google MCP tests: a minimal action-
 * registry runtime, a stub credential resolver yielding a fixed short-lived
 * token, and a fake MCP resource engine parameterized by per-attachment
 * discovery and tool results. Test-only; never imported by shipped code.
 */
import type { Action, IAgentRuntime, UUID } from "@elizaos/core";
import type {
  McpAttachmentRef,
  McpDiscovery,
  McpRemoteResource,
  McpResourceEngine,
} from "@elizaos/plugin-mcp/resource-engine";
import { vi } from "vitest";
import type { GoogleAuthClient, GoogleCredentialResolver } from "../../types.js";

type McpToolResult = Awaited<ReturnType<McpResourceEngine["callTool"]>>;

export function runtimeHarness(): IAgentRuntime & { actions: Action[] } {
  const actions: Action[] = [];
  return {
    agentId: "10000000-0000-0000-0000-000000000001" as UUID,
    actions,
    registerAction(action: Action) {
      if (!actions.some((candidate) => candidate.name === action.name)) actions.push(action);
    },
    unregisterAction(name: string) {
      const index = actions.findIndex((candidate) => candidate.name === name);
      if (index < 0) return false;
      actions.splice(index, 1);
      return true;
    },
    getService: () => undefined,
    // A structural fake cannot satisfy the full IAgentRuntime surface; this is
    // the one sanctioned widening for every Google MCP test harness.
  } as unknown as IAgentRuntime & { actions: Action[] };
}

export function stubCredentialResolver(token = "short-lived"): GoogleCredentialResolver {
  // The fake covers exactly the OAuth2Client members the host reads; the Pick
  // annotation keeps those members checked against the real client type.
  const authClient: Pick<GoogleAuthClient, "credentials" | "getAccessToken" | "setCredentials"> = {
    credentials: { access_token: token },
    getAccessToken: async () => ({ token }),
    setCredentials: () => undefined,
  };
  return {
    getAuthClient: async () => authClient as GoogleAuthClient,
  };
}

export interface EngineHarnessOptions {
  /** Discovered tools for one attachment, keyed by its attachment key (ends in `:<product>`). */
  toolsFor: (key: string) => McpDiscovery["tools"];
  callTool: (
    call: { name: string; arguments?: Record<string, unknown> },
    ref: McpAttachmentRef
  ) => McpToolResult | Promise<McpToolResult>;
}

export function engineHarness(options: EngineHarnessOptions) {
  const attachedResources: McpRemoteResource[] = [];
  let generation = 0;
  const attach = vi.fn(async (resource: McpRemoteResource) => {
    attachedResources.push(resource);
    return { key: resource.key, generation: String(++generation) };
  });
  const detach = vi.fn(async (_ref: McpAttachmentRef) => true);
  const discover = vi.fn(
    async (ref: McpAttachmentRef): Promise<McpDiscovery> => ({
      server: { capabilities: { tools: {} } },
      tools: options.toolsFor(ref.key),
      resources: [],
      resourceTemplates: [],
    })
  );
  const callTool = vi.fn(
    async (ref: McpAttachmentRef, call: { name: string; arguments?: Record<string, unknown> }) =>
      options.callTool(call, ref)
  );
  const engine: McpResourceEngine = { attach, detach, discover, callTool };
  return { engine, attach, detach, discover, callTool, attachedResources };
}
