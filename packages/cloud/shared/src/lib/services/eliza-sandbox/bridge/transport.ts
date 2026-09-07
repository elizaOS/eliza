/** Resolves and fetches authenticated sandbox API and web targets across Docker, legacy bridges, and Worker routing. Untrusted URLs retain SSRF validation; trusted routing derives from canonical sandbox and node records. */

import { isIP } from "node:net";
import { type AgentSandbox } from "../../../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../../../db/repositories/docker-nodes";
import { getElizaAgentPublicWebUiUrl } from "../../../eliza-agent-web-ui";
import { getCloudAwareEnv } from "../../../runtime/cloud-bindings";
import { assertSafeOutboundUrl } from "../../../security/outbound-url";
import { logger } from "../../../utils/logger";
import {
  AGENT_ID_RE,
  AgentApiTarget,
  AgentFetchTarget,
  AgentNetworkTarget,
  AgentRouterConfigurationError,
} from "./transport-contract.js";
export class SandboxTransport {
  getAgentApiToken(rec: Pick<AgentSandbox, "id" | "environment_vars">): string | undefined {
    const envVars = rec.environment_vars as Record<string, string> | null;
    const apiToken =
      envVars?.ELIZA_API_TOKEN?.trim() ||
      envVars?.ELIZAOS_API_KEY?.trim() ||
      envVars?.ELIZAOS_CLOUD_API_KEY?.trim();
    if (!apiToken) {
      logger.warn("[agent-sandbox] No API token for agent proxy", {
        agentId: rec.id,
      });
      return undefined;
    }
    return apiToken;
  }

  getAgentJsonHeaders(rec: Pick<AgentSandbox, "id" | "environment_vars">) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiToken = this.getAgentApiToken(rec);
    if (apiToken) {
      headers.Authorization = `Bearer ${apiToken}`;
      headers["X-Api-Key"] = apiToken;
      headers["X-Eliza-Token"] = apiToken;
    }
    return headers;
  }

  async getSafeBridgeEndpoint(
    sandboxOrBridgeUrl:
      | Pick<AgentSandbox, "bridge_url" | "node_id" | "bridge_port" | "headscale_ip" | "sandbox_id">
      | string,
    path: string,
    options?: { trusted?: boolean },
  ): Promise<string> {
    if (typeof sandboxOrBridgeUrl === "string") {
      if (options?.trusted) {
        return new URL(path, sandboxOrBridgeUrl).toString();
      }

      return (await assertSafeOutboundUrl(new URL(path, sandboxOrBridgeUrl).toString())).toString();
    }

    const dockerBridgeBaseUrl = await this.getTrustedDockerBridgeBaseUrl(sandboxOrBridgeUrl);
    if (
      dockerBridgeBaseUrl &&
      sandboxOrBridgeUrl.bridge_url &&
      this.matchesTrustedDockerBridge(sandboxOrBridgeUrl.bridge_url, dockerBridgeBaseUrl)
    ) {
      return new URL(path, dockerBridgeBaseUrl).toString();
    }

    if (!sandboxOrBridgeUrl.bridge_url) {
      throw new Error("Sandbox bridge is missing");
    }

    if (this.isTrustedLegacyPrivateBridgeUrl(sandboxOrBridgeUrl)) {
      return new URL(path, sandboxOrBridgeUrl.bridge_url).toString();
    }

    return (
      await assertSafeOutboundUrl(new URL(path, sandboxOrBridgeUrl.bridge_url).toString())
    ).toString();
  }

  getConfiguredAgentBaseDomain(): string | null {
    const configured = getCloudAwareEnv().ELIZA_CLOUD_AGENT_BASE_DOMAIN?.trim();
    if (!configured) return null;
    return this.normalizeConfiguredHostname(configured);
  }

  normalizeConfiguredHostname(hostname: string): string | null {
    const normalized = hostname
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .toLowerCase()
      .replace(/\.+$/, "");
    return normalized || null;
  }

  /**
   * Parse routing hosts more strictly than the display-URL helpers do. These
   * values select the recipient of the agent's bearer token, so a malformed
   * Worker binding must stop the request before fetch rather than fall back to
   * the public UUID hostname (which same-zone routing sends to wildcard DNS)
   * or a credential/path embedded in an otherwise hostname-only binding.
   */
  getRequiredWorkerRoutingHost(
    variable: "AGENT_ROUTER_ORIGIN_HOST" | "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
    value: string | undefined,
    options: { allowPort: boolean },
  ): string {
    const raw = value?.trim();
    if (!raw || raw.startsWith("//")) throw new AgentRouterConfigurationError(variable);

    let parsed: URL;
    try {
      parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    } catch {
      // error-policy:J3 an unparsable routing binding is an explicit invalid
      // configuration signal; it must never fall through to a token recipient.
      throw new AgentRouterConfigurationError(variable);
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    const validDnsName =
      hostname.length > 0 &&
      hostname.length <= 253 &&
      hostname
        .split(".")
        .every(
          (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
        );
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !validDnsName ||
      (!options.allowPort && parsed.port)
    ) {
      throw new AgentRouterConfigurationError(variable);
    }

    return parsed.port ? `${hostname}:${parsed.port}` : hostname;
  }

  getWorkerAgentRouterFetchTarget(rec: AgentNetworkTarget, path: string): AgentFetchTarget | null {
    if (!this.isCloudflareWorkerRuntime()) return null;

    const env = getCloudAwareEnv();
    const originHost = this.getRequiredWorkerRoutingHost(
      "AGENT_ROUTER_ORIGIN_HOST",
      env.AGENT_ROUTER_ORIGIN_HOST,
      { allowPort: true },
    );
    const baseDomain = this.getRequiredWorkerRoutingHost(
      "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
      env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
      { allowPort: false },
    );
    const agentId = rec.id.trim().toLowerCase();
    if (!AGENT_ID_RE.test(agentId)) {
      throw new Error("Worker agent routing requires a valid agent UUID");
    }

    const route = new URL(path, "https://agent-route.invalid/");
    if (route.origin !== "https://agent-route.invalid") {
      throw new Error("Agent API path must be relative to the agent origin");
    }

    const target = new URL(`https://${originHost}/`);
    target.pathname = route.pathname;
    target.search = route.search;
    target.hash = route.hash;
    return {
      url: target.toString(),
      forwardedHost: `${agentId}.${baseDomain}`,
    };
  }

  async getAgentApiFetchTarget(rec: AgentNetworkTarget, path: string): Promise<AgentFetchTarget> {
    const workerTarget = this.getWorkerAgentRouterFetchTarget(rec, path);
    if (workerTarget) return workerTarget;

    const baseDomain = this.getConfiguredAgentBaseDomain();

    const trustedWebBaseUrl = await this.getTrustedDockerWebBaseUrl(rec);
    if (trustedWebBaseUrl) {
      return { url: new URL(path, trustedWebBaseUrl).toString() };
    }

    if (baseDomain) {
      const publicEndpoint = getElizaAgentPublicWebUiUrl(rec, {
        baseDomain,
        path,
      });
      if (publicEndpoint) return { url: publicEndpoint };
    }

    return { url: await this.getSafeBridgeEndpoint(rec, path) };
  }

  async fetchAgentTarget(
    rec: Pick<AgentSandbox, "id" | "environment_vars">,
    target: AgentFetchTarget,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.delete("host");
    headers.delete("x-forwarded-host");
    headers.delete("x-forwarded-proto");
    const trustedHeaders = new Headers(this.getAgentJsonHeaders(rec));
    if (!trustedHeaders.has("authorization")) {
      throw new Error(`Agent proxy requires an API token for ${rec.id}`);
    }
    trustedHeaders.forEach((value, name) => headers.set(name, value));
    if (target.forwardedHost) {
      headers.set("x-forwarded-host", target.forwardedHost);
      headers.set("x-forwarded-proto", "https");
    }
    // Fetch strips Authorization on a cross-origin redirect, but preserves
    // custom auth headers such as X-Api-Key and X-Eliza-Token. Never let the
    // configured control-plane origin redirect an agent token to another host.
    return await fetch(target.url, { ...init, headers, redirect: "manual" });
  }

  async fetchAgentApi(
    rec: AgentApiTarget,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const target = await this.getAgentApiFetchTarget(rec, path);
    return await this.fetchAgentTarget(rec, target, init);
  }

  async fetchCanonicalConversationApi(
    rec: AgentApiTarget,
    path: string,
    init: RequestInit,
    canonicalBridgeBase: unknown,
  ): Promise<Response> {
    const trimTrailingSlashes = (value: string): string => {
      let end = value.length;
      while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
      return value.slice(0, end);
    };
    const requestedBase =
      typeof canonicalBridgeBase === "string"
        ? trimTrailingSlashes(canonicalBridgeBase.trim())
        : null;
    const storedBase = rec.bridge_url ? trimTrailingSlashes(rec.bridge_url.trim()) : null;
    if (requestedBase && requestedBase === storedBase) {
      const url = new URL(requestedBase);
      const isLoopback =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if ((url.protocol === "http:" || url.protocol === "https:") && isLoopback) {
        // The local control plane deliberately multiplexes sandboxes beneath a
        // path-prefixed loopback URL. Only the exact DB-owned target may bypass
        // outbound SSRF validation; preserving its prefix reaches the same
        // canonical conversation that accepted the cutover import.
        return await this.fetchAgentTarget(rec, { url: `${requestedBase}${path}` }, init);
      }
    }

    const baseDomain = this.getConfiguredAgentBaseDomain();
    if (baseDomain) {
      const workerTarget = this.getWorkerAgentRouterFetchTarget(rec, path);
      if (workerTarget) {
        return await this.fetchAgentTarget(rec, workerTarget, init);
      }
      const publicEndpoint = getElizaAgentPublicWebUiUrl(rec, {
        baseDomain,
        path,
      });
      if (publicEndpoint) {
        return await this.fetchAgentTarget(rec, { url: publicEndpoint }, init);
      }
    }

    return await this.fetchAgentTarget(
      rec,
      {
        url: await this.getSafeBridgeEndpoint(rec, path),
      },
      init,
    );
  }

  async getAgentWebFetchTarget(rec: AgentNetworkTarget, path: string): Promise<AgentFetchTarget> {
    const workerTarget = this.getWorkerAgentRouterFetchTarget(rec, path);
    if (workerTarget) return workerTarget;

    return { url: await this.getAgentWebEndpoint(rec, path) };
  }

  async fetchAgentWeb(
    rec: AgentApiTarget,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const target = await this.getAgentWebFetchTarget(rec, path);
    return await this.fetchAgentTarget(rec, target, init);
  }

  async getAgentWebEndpoint(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    path: string,
  ): Promise<string> {
    const baseDomain = this.getConfiguredAgentBaseDomain();
    const publicEndpoint = getElizaAgentPublicWebUiUrl(
      rec,
      baseDomain ? { baseDomain, path } : { path },
    );
    if (publicEndpoint) return publicEndpoint;

    const trustedWebBaseUrl = await this.getTrustedDockerWebBaseUrl(rec);
    if (trustedWebBaseUrl) {
      return new URL(path, trustedWebBaseUrl).toString();
    }

    return this.getSafeBridgeEndpoint(rec, path);
  }

  async getTrustedDockerWebBaseUrl(
    sandbox: Pick<
      AgentSandbox,
      "node_id" | "web_ui_port" | "headscale_ip" | "health_url" | "bridge_url"
    >,
  ): Promise<string | null> {
    if (sandbox.health_url) {
      try {
        return new URL(sandbox.health_url).origin;
      } catch {
        // Fall through to metadata-based resolution.
      }
    }

    if (!sandbox.node_id || !sandbox.web_ui_port) {
      return null;
    }

    const host =
      sandbox.headscale_ip || (await dockerNodesRepository.findByNodeId(sandbox.node_id))?.hostname;
    if (!host) {
      return null;
    }

    return `http://${host}:${sandbox.web_ui_port}`;
  }

  async getTrustedDockerBridgeBaseUrl(
    sandbox: Pick<AgentSandbox, "node_id" | "bridge_port" | "headscale_ip">,
  ): Promise<string | null> {
    if (!sandbox.node_id || !sandbox.bridge_port) {
      return null;
    }

    const host =
      sandbox.headscale_ip || (await dockerNodesRepository.findByNodeId(sandbox.node_id))?.hostname;
    if (!host) {
      return null;
    }

    return `http://${host}:${sandbox.bridge_port}`;
  }

  isTrustedLegacyPrivateBridgeUrl(
    sandbox: Pick<
      AgentSandbox,
      "bridge_url" | "node_id" | "bridge_port" | "headscale_ip" | "sandbox_id"
    >,
  ): boolean {
    if (!sandbox.bridge_url) {
      return false;
    }

    let candidate: URL;
    try {
      candidate = new URL(sandbox.bridge_url);
    } catch {
      return false;
    }

    if (candidate.protocol !== "http:" || !this.isAgentPrivateBridgeHost(candidate.hostname)) {
      return false;
    }

    const candidatePort = Number.parseInt(candidate.port, 10);
    const hasMatchingBridgePort =
      sandbox.bridge_port != null &&
      Number.isInteger(candidatePort) &&
      candidatePort === sandbox.bridge_port;
    const hasMatchingHeadscaleIp =
      !!sandbox.headscale_ip && candidate.hostname === sandbox.headscale_ip;
    const hasDockerNodeSignal = !!sandbox.node_id;
    // Older Docker-backed records may predate the node/headscale backfill but
    // still carry the provider-generated `sandbox_id`/container name.

    return (
      hasMatchingHeadscaleIp ||
      (hasDockerNodeSignal && hasMatchingBridgePort) ||
      (hasDockerNodeSignal && hasMatchingHeadscaleIp)
    );
  }

  isLegacyDockerSandboxId(sandboxId: string | null | undefined): boolean {
    return typeof sandboxId === "string" && /^agent-[0-9a-f-]{36}$/i.test(sandboxId);
  }

  isAgentPrivateBridgeHost(hostname: string): boolean {
    if (isIP(hostname) !== 4) {
      return false;
    }

    const [first, second] = hostname.split(".").map((part) => Number.parseInt(part, 10));
    // CGNAT (100.64.0.0/10)
    if (first === 100 && second >= 64 && second <= 127) return true;
    // RFC1918: 10.0.0.0/8
    if (first === 10) return true;
    // RFC1918: 172.16.0.0/12
    if (first === 172 && second >= 16 && second <= 31) return true;
    // RFC1918: 192.168.0.0/16
    if (first === 192 && second === 168) return true;
    return false;
  }

  matchesTrustedDockerBridge(bridgeUrl: string, trustedDockerBridgeBaseUrl: string): boolean {
    try {
      const candidate = new URL(bridgeUrl);
      const trusted = new URL(trustedDockerBridgeBaseUrl);
      return candidate.host === trusted.host;
    } catch {
      return false;
    }
  }

  isCloudflareWorkerRuntime(): boolean {
    return typeof globalThis !== "undefined" && "WebSocketPair" in globalThis;
  }
}
