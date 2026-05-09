import type http from "node:http";
import { ensureCompatApiAuthorized } from "@elizaos/app-core";
import {
  type CompatRuntimeState,
  getConfiguredCompatAgentName,
  isLoopbackRemoteAddress,
  readCompatJsonBody,
} from "@elizaos/app-core";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "@elizaos/app-core";
import { logger } from "@elizaos/core";
import { getWalletAddresses } from "../api/wallet";
import {
  approveStewardTransaction,
  createStewardClient,
  denyStewardTransaction,
  ensureStewardAgent,
  getRecentWebhookEvents,
  getStewardBalance,
  getStewardBridgeStatus,
  getStewardHistory,
  getStewardPendingApprovals,
  getStewardTokenBalances,
  getStewardWalletAddresses,
  isStewardConfigured,
  pushWebhookEvent,
  resolveStewardAgentId,
  type StewardWebhookEventType,
  signViaSteward,
} from "./steward-bridge";

/**
 * Steward wallet routes:
 *
 * - `GET    /api/wallet/steward-status`
 * - `GET    /api/wallet/steward-policies`
 * - `PUT    /api/wallet/steward-policies`
 * - `GET    /api/wallet/steward-tx-records`
 * - `GET    /api/wallet/steward-pending-approvals`
 * - `POST   /api/wallet/steward-approve-tx`
 * - `POST   /api/wallet/steward-deny-tx`
 * - `POST   /api/wallet/steward-webhook`       (loopback only, no auth)
 * - `GET    /api/wallet/steward-webhook-events`
 * - `POST   /api/wallet/steward-sign`
 * - `GET    /api/wallet/steward-addresses`
 * - `GET    /api/wallet/steward-balances`
 * - `GET    /api/wallet/steward-tokens`
 */
export async function handleStewardCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  // Quick prefix check — all steward routes live under /api/wallet/steward-*
  if (!url.pathname.startsWith("/api/wallet/steward")) {
    return false;
  }

  // ── GET /api/wallet/steward-status ──────────────────────────────────
  if (method === "GET" && url.pathname === "/api/wallet/steward-status") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const addresses = getWalletAddresses();

    // Lazy initialization: on first request, ensure the steward agent exists
    if (isStewardConfigured()) {
      const agentId = resolveStewardAgentId(process.env, addresses.evmAddress);
      const characterName = getConfiguredCompatAgentName();
      void ensureStewardAgent({
        agentId: agentId ?? undefined,
        agentName: characterName ?? undefined,
      }).catch(() => {
        /* non-fatal — logged internally */
      });
    }

    const status = await getStewardBridgeStatus({
      evmAddress: addresses.evmAddress,
    });
    sendJsonResponse(res, 200, status);
    return true;
  }

  // ── GET /api/wallet/steward-policies ────────────────────────────────
  if (method === "GET" && url.pathname === "/api/wallet/steward-policies") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const addresses = getWalletAddresses();
    const agentId = resolveStewardAgentId(process.env, addresses.evmAddress);
    const stewardClient = createStewardClient();

    if (!stewardClient || !agentId) {
      sendJsonResponse(res, 503, {
        error: "Steward not configured",
      });
      return true;
    }

    try {
      const policies = await stewardClient.getPolicies(agentId);
      sendJsonResponse(res, 200, policies);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch policies";
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  // ── PUT /api/wallet/steward-policies ────────────────────────────────
  if (method === "PUT" && url.pathname === "/api/wallet/steward-policies") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (!body) return true;

    const { policies } = body as {
      policies: Array<{
        id: string;
        type: string;
        enabled: boolean;
        config: Record<string, unknown>;
      }>;
    };

    if (!Array.isArray(policies)) {
      sendJsonResponse(res, 400, {
        error: "policies must be an array",
      });
      return true;
    }

    const addresses = getWalletAddresses();
    const agentId = resolveStewardAgentId(process.env, addresses.evmAddress);
    const stewardClient = createStewardClient();

    if (!stewardClient || !agentId) {
      sendJsonResponse(res, 503, {
        error: "Steward not configured",
      });
      return true;
    }

    try {
      await stewardClient.setPolicies(
        agentId,
        policies as unknown as import("@stwd/sdk").PolicyRule[],
      );
      sendJsonResponse(res, 200, { ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save policies";
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  // ── GET /api/wallet/steward-tx-records ──────────────────────────────
  if (method === "GET" && url.pathname === "/api/wallet/steward-tx-records") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const addresses = getWalletAddresses();
    const agentId = resolveStewardAgentId(process.env, addresses.evmAddress);

    if (!agentId || !createStewardClient()) {
      sendJsonResponse(res, 503, {
        error: "Steward not configured",
      });
      return true;
    }

    try {
      const status = url.searchParams.get("status") || undefined;
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);
      const history = await getStewardHistory(agentId, {
        limit,
        offset,
      });
      const filtered = status
        ? history.filter((h: { status: string }) => h.status === status)
        : history;
      sendJsonResponse(res, 200, {
        records: filtered,
        total: filtered.length,
        offset,
        limit,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch tx records";
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  // ── GET /api/wallet/steward-pending-approvals ───────────────────────
  if (
    method === "GET" &&
    url.pathname === "/api/wallet/steward-pending-approvals"
  ) {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const addresses = getWalletAddresses();
    const agentId = resolveStewardAgentId(process.env, addresses.evmAddress);

    if (!agentId || !createStewardClient()) {
      sendJsonResponse(res, 503, {
        error: "Steward not configured",
      });
      return true;
    }

    try {
      const pending = await getStewardPendingApprovals(agentId);
      sendJsonResponse(res, 200, pending);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to fetch pending approvals";
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  // ── POST /api/wallet/steward-approve-tx | steward-deny-tx ──────────
  if (
    method === "POST" &&
    (url.pathname === "/api/wallet/steward-approve-tx" ||
      url.pathname === "/api/wallet/steward-deny-tx")
  ) {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (!body) return true;

    const txId = typeof body.txId === "string" ? body.txId : "";
    if (!txId) {
      sendJsonResponse(res, 400, { error: "txId is required" });
      return true;
    }

    const addresses = getWalletAddresses();
    const agentId = resolveStewardAgentId(process.env, addresses.evmAddress);

    if (!agentId || !createStewardClient()) {
      sendJsonResponse(res, 503, {
        error: "Steward not configured",
      });
      return true;
    }

    const isApprove = url.pathname.includes("approve");
    const reason = typeof body.reason === "string" ? body.reason : undefined;

    try {
      const result = isApprove
        ? await approveStewardTransaction(agentId, txId)
        : await denyStewardTransaction(agentId, txId, reason);
      sendJsonResponse(res, 200, { ok: true, ...result });
    } catch (err) {
      const action = isApprove ? "approve" : "deny";
      const message =
        err instanceof Error ? err.message : `Failed to ${action} transaction`;
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  // ── POST /api/wallet/steward-webhook (loopback only, no auth) ──────
  if (method === "POST" && url.pathname === "/api/wallet/steward-webhook") {
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      logger.warn(
        `[steward-webhook] Rejected non-loopback request from ${req.socket?.remoteAddress}`,
      );
      sendJsonErrorResponse(res, 403, "Webhook only accepted from localhost");
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (!body) return true;

    const event = typeof body.event === "string" ? body.event : "";
    const VALID_EVENTS: StewardWebhookEventType[] = [
      "tx.pending",
      "tx.approved",
      "tx.denied",
      "tx.confirmed",
    ];

    if (!VALID_EVENTS.includes(event as StewardWebhookEventType)) {
      sendJsonResponse(res, 400, { error: `Unknown event type: ${event}` });
      return true;
    }

    const data =
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? (body.data as Record<string, unknown>)
        : {};

    pushWebhookEvent({
      event: event as StewardWebhookEventType,
      data,
      timestamp: new Date().toISOString(),
    });

    logger.info(`[steward-webhook] Received ${event}`);
    sendJsonResponse(res, 200, { ok: true });
    return true;
  }

  // ── GET /api/wallet/steward-webhook-events ──────────────────────────
  if (
    method === "GET" &&
    url.pathname === "/api/wallet/steward-webhook-events"
  ) {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const eventType = url.searchParams.get(
      "event",
    ) as StewardWebhookEventType | null;
    const sinceIndex = Number.parseInt(
      url.searchParams.get("since") || "0",
      10,
    );

    const result = getRecentWebhookEvents(
      eventType || undefined,
      Number.isNaN(sinceIndex) ? 0 : sinceIndex,
    );
    sendJsonResponse(res, 200, result);
    return true;
  }

  // ── POST /api/wallet/steward-sign ───────────────────────────────────
  if (method === "POST" && url.pathname === "/api/wallet/steward-sign") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (!body) return true;

    const to = typeof body.to === "string" ? body.to.trim() : "";
    const value = typeof body.value === "string" ? body.value.trim() : "";
    const chainId =
      typeof body.chainId === "number" ? body.chainId : Number(body.chainId);
    const data = typeof body.data === "string" ? body.data : undefined;
    const description =
      typeof body.description === "string" ? body.description : undefined;

    if (!to || !value || !Number.isFinite(chainId) || chainId <= 0) {
      sendJsonResponse(res, 400, {
        error: "to, value, and a valid chainId are required",
      });
      return true;
    }

    try {
      const result = await signViaSteward({
        to,
        value,
        chainId,
        data,
        broadcast: true,
        description,
      });

      if (result.approved) {
        sendJsonResponse(res, 200, result);
      } else if (result.pending) {
        sendJsonResponse(res, 202, result);
      } else if (result.denied) {
        sendJsonResponse(res, 403, result);
      } else {
        sendJsonResponse(res, 200, result);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Steward sign failed";
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  // ── GET /api/wallet/steward-addresses ───────────────────────────────
  if (method === "GET" && url.pathname === "/api/wallet/steward-addresses") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    try {
      const addresses = getWalletAddresses();
      const stewardAddresses = await getStewardWalletAddresses({
        evmAddress: addresses.evmAddress,
      });
      sendJsonResponse(res, 200, stewardAddresses);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to fetch steward addresses";
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  // ── GET /api/wallet/steward-balances ────────────────────────────────
  if (method === "GET" && url.pathname === "/api/wallet/steward-balances") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const addresses = getWalletAddresses();
    const agentId = resolveStewardAgentId(process.env, addresses.evmAddress);

    if (!agentId || !createStewardClient()) {
      sendJsonResponse(res, 503, { error: "Steward not configured" });
      return true;
    }

    const chainId = url.searchParams.get("chainId");
    const parsedChainId = chainId ? Number.parseInt(chainId, 10) : undefined;

    try {
      const balance = await getStewardBalance(agentId, parsedChainId);
      sendJsonResponse(res, 200, balance);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch steward balance";
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  // ── GET /api/wallet/steward-tokens ──────────────────────────────────
  if (method === "GET" && url.pathname === "/api/wallet/steward-tokens") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const addresses = getWalletAddresses();
    const agentId = resolveStewardAgentId(process.env, addresses.evmAddress);

    if (!agentId || !createStewardClient()) {
      sendJsonResponse(res, 503, { error: "Steward not configured" });
      return true;
    }

    const chainId = url.searchParams.get("chainId");
    const parsedChainId = chainId ? Number.parseInt(chainId, 10) : undefined;

    try {
      const tokens = await getStewardTokenBalances(agentId, parsedChainId);
      sendJsonResponse(res, 200, tokens);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch steward tokens";
      sendJsonResponse(res, 500, { error: message });
    }
    return true;
  }

  return false;
}
