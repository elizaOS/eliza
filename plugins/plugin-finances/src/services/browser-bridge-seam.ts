/**
 * Browser-bridge runtime-service seam for the subscriptions back-end.
 *
 * Subscription cancellation drives the user's real Chrome / Safari through the
 * Agent Browser Bridge companion: it lists connected companions, creates a
 * browser session from a cancellation playbook, and polls that session's
 * status. `@elizaos/plugin-browser` owns the contract for this — it exports the
 * `BrowserBridgeRouteService` interface and the
 * `BROWSER_BRIDGE_ROUTE_SERVICE_TYPE` ("lifeops_browser_plugin") service type;
 * a host plugin (today, plugin-personal-assistant) registers the implementor
 * that persists companions and sessions.
 *
 * This module resolves that runtime service by service-type and exposes only
 * the narrow surface the subscriptions path needs. It carries no dependency on
 * `@elizaos/plugin-personal-assistant`: the contract lives entirely in
 * `@elizaos/plugin-browser`, the same way the BrowserService bridge target
 * resolves it.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeCompanionStatus,
  type BrowserBridgeRouteService,
} from "@elizaos/plugin-browser";
import type {
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
} from "@elizaos/plugin-browser/lifeops-session-contracts";
import { fail } from "../finance-normalize.ts";

/**
 * The browser-bridge surface the subscriptions back-end needs, bound to the
 * registered `lifeops_browser_plugin` runtime service for the resolved owner.
 */
export interface SubscriptionsBrowserGateway {
  /** Connected + pending Agent Browser Bridge companions for the owner. */
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
  /** Create a browser session that runs the cancellation playbook. */
  createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  /** Fetch a browser session by id (used to reconcile cancellation status). */
  getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession>;
}

function requireBrowserBridgeService(
  runtime: IAgentRuntime,
): BrowserBridgeRouteService {
  const service = runtime.getService(BROWSER_BRIDGE_ROUTE_SERVICE_TYPE);
  if (!service || typeof service !== "object") {
    fail(
      503,
      "Browser bridge service is not registered. Enable the Agent Browser Bridge host plugin before using subscription cancellation in a browser.",
    );
  }
  return service as unknown as BrowserBridgeRouteService;
}

/**
 * Build the subscriptions browser gateway bound to a runtime + owner. The owner
 * entity id is forwarded to the host service so companion + session scoping
 * matches the owner the finances service resolved.
 */
export function createSubscriptionsBrowserGateway(
  runtime: IAgentRuntime,
  ownerEntityId: string | null,
): SubscriptionsBrowserGateway {
  return {
    async listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]> {
      return requireBrowserBridgeService(runtime).listBrowserCompanions(
        ownerEntityId,
      );
    },
    async createBrowserSession(
      request: CreateLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      return requireBrowserBridgeService(runtime).createBrowserSession(
        request,
        ownerEntityId,
      );
    },
    async getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession> {
      return requireBrowserBridgeService(runtime).getBrowserSession(
        sessionId,
        ownerEntityId,
      );
    },
  };
}
