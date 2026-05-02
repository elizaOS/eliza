/**
 * Vault routes — transaction signing, approval/rejection, history, key import,
 * multi-wallet addresses, RPC passthrough, Solana signing, EIP-712 typed data.
 *
 * Mount: app.route("/vault", vaultRoutes)
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { enforceRateLimit, recordVaultSpend } from "../middleware/redis-enforcement";
import {
  type ApiResponse,
  type AppVariables,
  approvalQueue,
  db,
  ensureAgentForTenant,
  extractRpcErrorMessage,
  getPolicySet,
  getTransactionStats,
  isNonEmptyString,
  isRpcError,
  isValidAddress,
  isValidAgentId,
  isValidAnyAddress,
  isValidSolanaAddress,
  policyEngine,
  priceOracle,
  type RpcRequest,
  type RpcResponse,
  requireAgentAccess,
  requireTenantLevel,
  type SignRequest,
  type SignTypedDataRequest,
  safeJsonParse,
  sanitizeErrorMessage,
  tenantConfigs,
  toSignRequest,
  toTxRecord,
  transactions,
  vault,
  webhookDispatcher,
} from "../services/context";

export const vaultRoutes = new Hono<{ Variables: AppVariables }>();

// ─── Sign transaction (EVM) ───────────────────────────────────────────────────

vaultRoutes.post("/:agentId/sign", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const request = await safeJsonParse<Omit<SignRequest, "agentId" | "tenantId">>(c);
  if (!request) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(request.to)) {
    return c.json<ApiResponse>({ ok: false, error: "'to' address is required" }, 400);
  }
  if (!isValidAnyAddress(request.to)) {
    const errMsg = request.to.startsWith("0x")
      ? "'to' must be a valid Ethereum address (0x + 40 hex chars)"
      : "'to' must be a valid Ethereum address (0x + 40 hex chars) or a valid Solana address (base58, 32–44 chars)";
    return c.json<ApiResponse>({ ok: false, error: errMsg }, 400);
  }
  if (request.value === undefined || request.value === null) {
    return c.json<ApiResponse>(
      { ok: false, error: "'value' is required (wei amount as string)" },
      400,
    );
  }

  const resolvedChainId = request.chainId || parseInt(process.env.CHAIN_ID || "8453", 10);
  const signRequest: SignRequest = {
    ...request,
    tenantId,
    agentId,
    chainId: resolvedChainId,
  };
  const policySet = await getPolicySet(tenantId, agentId);

  // ── Redis rate-limit check (before policy evaluation) ──────────────────────
  const rateLimitResult = await enforceRateLimit(agentId, policySet);
  if (!rateLimitResult.allowed) {
    if (rateLimitResult.headers) {
      for (const [key, value] of Object.entries(rateLimitResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json<ApiResponse>(
      { ok: false, error: rateLimitResult.reason || "Rate limit exceeded" },
      429,
    );
  }
  // Set rate limit headers on success too
  if (rateLimitResult.headers) {
    for (const [key, value] of Object.entries(rateLimitResult.headers)) {
      c.header(key, value);
    }
  }

  const stats = await getTransactionStats(agentId);

  const evaluation = await policyEngine.evaluate(policySet, {
    request: signRequest,
    recentTxCount1h: stats.recentTxCount1h,
    recentTxCount24h: stats.recentTxCount24h,
    spentToday: stats.spentToday,
    spentThisWeek: stats.spentThisWeek,
    priceOracle,
  });

  if (!evaluation.approved) {
    const txId = crypto.randomUUID();

    if (evaluation.requiresManualApproval) {
      await db.transaction(async (tx) => {
        await tx.insert(transactions).values({
          id: txId,
          agentId,
          status: "pending",
          toAddress: signRequest.to,
          value: signRequest.value,
          data: signRequest.data,
          chainId: signRequest.chainId,
          policyResults: evaluation.results,
        });
        await tx.insert(approvalQueue).values({
          id: crypto.randomUUID(),
          txId,
          agentId,
          status: "pending",
        });
      });

      dispatchWebhook(tenantId, agentId, "approval_required", {
        txId,
        results: evaluation.results,
      });

      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Transaction requires manual approval",
          data: {
            txId,
            results: evaluation.results,
            status: "pending_approval",
          },
        },
        202,
      );
    }

    await db.insert(transactions).values({
      id: txId,
      agentId,
      status: "rejected",
      toAddress: signRequest.to,
      value: signRequest.value,
      data: signRequest.data,
      chainId: signRequest.chainId,
      policyResults: evaluation.results,
    });

    dispatchWebhook(tenantId, agentId, "tx_rejected", {
      txId,
      results: evaluation.results,
    });

    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction rejected by policy",
        data: { txId, results: evaluation.results },
      },
      403,
    );
  }

  try {
    const txId = crypto.randomUUID();
    const shouldBroadcast = signRequest.broadcast !== false;
    const result = await vault.signTransaction(signRequest, {
      txId,
      policyResults: evaluation.results,
      status: "signed",
    });

    await db
      .update(transactions)
      .set({
        status: "signed",
        txHash: shouldBroadcast ? result : undefined,
        policyResults: evaluation.results,
        signedAt: new Date(),
      })
      .where(eq(transactions.id, txId));

    // ── Record spend in Redis (fire-and-forget) ──────────────────────────────
    recordVaultSpend(agentId, tenantId, signRequest.value, resolvedChainId).catch((err) =>
      console.error("[vault] Failed to record spend:", err),
    );

    dispatchWebhook(tenantId, agentId, "tx_signed", {
      txId,
      txHash: shouldBroadcast ? result : undefined,
    });

    if (shouldBroadcast) {
      return c.json<ApiResponse<{ txId: string; txHash: string }>>({
        ok: true,
        data: { txId, txHash: result },
      });
    }

    return c.json<ApiResponse<{ txId: string; signedTx: string }>>({
      ok: true,
      data: { txId, signedTx: result },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    const rawMessage = e instanceof Error ? e.message : "Unknown error";
    console.error(`[${requestId}] Sign transaction failed for agent ${agentId}:`, e);

    dispatchWebhook(tenantId, agentId, "tx_failed", {
      error: rawMessage,
      requestId,
    });

    if (isRpcError(e)) {
      return c.json<ApiResponse>({ ok: false, error: extractRpcErrorMessage(e) }, 502);
    }
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

// ─── Approve transaction ──────────────────────────────────────────────────────

vaultRoutes.post("/:agentId/approve/:txId", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction approval requires tenant-level authentication",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const txId = c.req.param("txId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const [transaction] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)));
  if (!transaction) {
    return c.json<ApiResponse>({ ok: false, error: "Transaction not found" }, 404);
  }

  const resolvedAt = new Date();
  const claimResult = await db
    .update(approvalQueue)
    .set({ status: "approved", resolvedAt, resolvedBy: tenantId })
    .where(
      and(
        eq(approvalQueue.txId, txId),
        eq(approvalQueue.agentId, agentId),
        eq(approvalQueue.status, "pending"),
      ),
    )
    .returning();

  if (claimResult.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction already processed or not found" },
      409,
    );
  }

  try {
    const isSolana = transaction.chainId === 101 || transaction.chainId === 102;
    let txHash: string;

    if (isSolana) {
      if (!transaction.data) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Solana transaction blob not found — cannot replay approval",
          },
          500,
        );
      }
      const result = await vault.signSolanaTransaction({
        agentId,
        tenantId,
        transaction: transaction.data,
        chainId: transaction.chainId,
        broadcast: true,
      });
      txHash = result.signature;
    } else {
      txHash = await vault.signTransaction(
        { ...toSignRequest(transaction), tenantId },
        { txId, policyResults: transaction.policyResults, status: "signed" },
      );
    }

    await db
      .update(transactions)
      .set({ status: "signed", txHash, signedAt: resolvedAt })
      .where(eq(transactions.id, txId));

    dispatchWebhook(tenantId, agentId, "tx_signed", { txId, txHash });

    return c.json<ApiResponse<{ txId: string; txHash: string }>>({
      ok: true,
      data: { txId, txHash },
    });
  } catch (e: unknown) {
    // Revert the atomic claim so the approval can be retried
    await db
      .update(approvalQueue)
      .set({ status: "pending", resolvedAt: null, resolvedBy: null })
      .where(and(eq(approvalQueue.txId, txId), eq(approvalQueue.agentId, agentId)));

    const requestId = c.get("requestId") || "unknown";
    const rawMessage = e instanceof Error ? e.message : "Unknown error";
    console.error(`[${requestId}] Approve transaction failed for agent ${agentId}, tx ${txId}:`, e);

    dispatchWebhook(tenantId, agentId, "tx_failed", {
      txId,
      error: rawMessage,
      requestId,
    });

    if (isRpcError(e)) {
      return c.json<ApiResponse>({ ok: false, error: extractRpcErrorMessage(e) }, 502);
    }
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

// ─── Reject transaction ───────────────────────────────────────────────────────

vaultRoutes.post("/:agentId/reject/:txId", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction approval requires tenant-level authentication",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const txId = c.req.param("txId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const rejectResult = await db
    .update(approvalQueue)
    .set({ status: "rejected", resolvedAt: new Date(), resolvedBy: tenantId })
    .where(
      and(
        eq(approvalQueue.txId, txId),
        eq(approvalQueue.agentId, agentId),
        eq(approvalQueue.status, "pending"),
      ),
    )
    .returning();

  if (rejectResult.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "Transaction already processed or not found" },
      409,
    );
  }

  await db
    .update(transactions)
    .set({ status: "rejected" })
    .where(and(eq(transactions.id, txId), eq(transactions.agentId, agentId)));

  return c.json<ApiResponse>({ ok: true });
});

// ─── Pending approvals ────────────────────────────────────────────────────────

vaultRoutes.get("/:agentId/pending", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const pendingTransactions = await db
    .select({
      queueId: approvalQueue.id,
      status: approvalQueue.status,
      requestedAt: approvalQueue.requestedAt,
      transaction: transactions,
    })
    .from(approvalQueue)
    .innerJoin(transactions, eq(transactions.id, approvalQueue.txId))
    .where(
      and(
        eq(approvalQueue.agentId, agentId),
        eq(approvalQueue.status, "pending"),
        eq(transactions.agentId, agentId),
      ),
    );

  return c.json<ApiResponse>({
    ok: true,
    data: pendingTransactions.map((entry) => ({
      queueId: entry.queueId,
      status: entry.status,
      requestedAt: entry.requestedAt,
      transaction: toTxRecord(entry.transaction),
    })),
  });
});

// ─── Transaction history ──────────────────────────────────────────────────────

vaultRoutes.get("/:agentId/history", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const history = await db.select().from(transactions).where(eq(transactions.agentId, agentId));

  return c.json<ApiResponse>({
    ok: true,
    data: history.map(toTxRecord),
  });
});

// ─── EIP-712 Typed Data Signing ───────────────────────────────────────────────

// ─── Sign arbitrary message (personal_sign / eth_sign) ───────────────────────────────
//
// Used by server-to-server flows that need an off-chain signature from an
// agent (e.g. four.meme SIWE login). EVM uses viem's personal_sign over the
// UTF-8 bytes of the message. Solana uses Ed25519 over the message bytes.
//
// POST /vault/:agentId/sign-message
// body: { "message": "<string>" }
// resp: { ok: true, data: { signature: "0x..." } }
vaultRoutes.post("/:agentId/sign-message", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{ message: string }>(c);
  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }
  if (!isNonEmptyString(body.message)) {
    return c.json<ApiResponse>({ ok: false, error: "'message' is required" }, 400);
  }

  try {
    const signature = await vault.signMessage(tenantId, agentId, body.message);
    return c.json<ApiResponse>({ ok: true, data: { signature } });
  } catch (e) {
    console.error(`[Vault] sign-message failed for ${tenantId}/${agentId}:`, e);
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

vaultRoutes.post("/:agentId/sign-typed-data", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{
    domain: SignTypedDataRequest["domain"];
    types: SignTypedDataRequest["types"];
    primaryType: string;
    value: Record<string, unknown>;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!body.domain || typeof body.domain !== "object") {
    return c.json<ApiResponse>(
      { ok: false, error: "'domain' is required and must be an object" },
      400,
    );
  }
  if (!body.types || typeof body.types !== "object") {
    return c.json<ApiResponse>(
      { ok: false, error: "'types' is required and must be an object" },
      400,
    );
  }
  if (!isNonEmptyString(body.primaryType)) {
    return c.json<ApiResponse>({ ok: false, error: "'primaryType' is required" }, 400);
  }
  if (!body.value || typeof body.value !== "object") {
    return c.json<ApiResponse>(
      { ok: false, error: "'value' is required and must be an object" },
      400,
    );
  }

  const resolvedChainId =
    (typeof body.domain.chainId === "number" ? body.domain.chainId : 0) ||
    parseInt(process.env.CHAIN_ID || "8453", 10);
  const signRequest: SignRequest = {
    agentId,
    tenantId,
    to: "0x0000000000000000000000000000000000000000",
    value: "0",
    chainId: resolvedChainId,
  };

  const policySet = await getPolicySet(tenantId, agentId);

  // ── Redis rate-limit check (typed data) ────────────────────────────────────
  const rlResult = await enforceRateLimit(agentId, policySet);
  if (!rlResult.allowed) {
    if (rlResult.headers) {
      for (const [key, value] of Object.entries(rlResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json<ApiResponse>({ ok: false, error: rlResult.reason || "Rate limit exceeded" }, 429);
  }

  const stats = await getTransactionStats(agentId);

  const evaluation = await policyEngine.evaluate(policySet, {
    request: signRequest,
    recentTxCount1h: stats.recentTxCount1h,
    recentTxCount24h: stats.recentTxCount24h,
    spentToday: stats.spentToday,
    spentThisWeek: stats.spentThisWeek,
    priceOracle,
  });

  if (!evaluation.approved) {
    const txId = crypto.randomUUID();

    if (evaluation.requiresManualApproval) {
      await db.transaction(async (tx) => {
        await tx.insert(transactions).values({
          id: txId,
          agentId,
          status: "pending",
          toAddress: signRequest.to,
          value: signRequest.value,
          chainId: signRequest.chainId,
          policyResults: evaluation.results,
        });
        await tx.insert(approvalQueue).values({
          id: crypto.randomUUID(),
          txId,
          agentId,
          status: "pending",
        });
      });

      dispatchWebhook(tenantId, agentId, "approval_required", {
        txId,
        results: evaluation.results,
      });

      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Transaction requires manual approval",
          data: {
            txId,
            results: evaluation.results,
            status: "pending_approval",
          },
        },
        202,
      );
    }

    await db.insert(transactions).values({
      id: txId,
      agentId,
      status: "rejected",
      toAddress: signRequest.to,
      value: signRequest.value,
      chainId: signRequest.chainId,
      policyResults: evaluation.results,
    });

    dispatchWebhook(tenantId, agentId, "tx_rejected", {
      txId,
      results: evaluation.results,
    });

    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction rejected by policy",
        data: { txId, results: evaluation.results },
      },
      403,
    );
  }

  const txId = crypto.randomUUID();

  try {
    const signature = await vault.signTypedData({
      agentId,
      tenantId,
      domain: body.domain,
      types: body.types,
      primaryType: body.primaryType,
      value: body.value,
    });

    await db.insert(transactions).values({
      id: txId,
      agentId,
      status: "signed",
      toAddress: signRequest.to,
      value: signRequest.value,
      chainId: signRequest.chainId,
      policyResults: evaluation.results,
      signedAt: new Date(),
    });

    dispatchWebhook(tenantId, agentId, "tx_signed", { txId });

    return c.json<ApiResponse<{ signature: string; txId: string }>>({
      ok: true,
      data: { signature, txId },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    const rawMessage = e instanceof Error ? e.message : "Unknown error";
    console.error(`[${requestId}] Sign typed data failed for agent ${agentId}:`, e);

    dispatchWebhook(tenantId, agentId, "tx_failed", {
      txId,
      error: rawMessage,
      requestId,
    });

    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

// ─── Solana Transaction Signing ───────────────────────────────────────────────

vaultRoutes.post("/:agentId/sign-solana", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{
    transaction: string;
    chainId?: number;
    broadcast?: boolean;
    to?: string;
    value?: string;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.transaction)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "'transaction' is required (base64-encoded serialized Solana transaction)",
      },
      400,
    );
  }

  if (body.to !== undefined && body.to !== "") {
    if (!isValidSolanaAddress(body.to) && !isValidAddress(body.to)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "'to' must be a valid Solana address (base58, 32–44 chars) or Ethereum address",
        },
        400,
      );
    }
  }

  if (!body.to || !body.value) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Solana signing requires 'to' (recipient address) and 'value' (lamports as string) for policy evaluation",
      },
      400,
    );
  }

  const chainId = body.chainId ?? 101;
  const toAddress = body.to;
  const txValue = body.value;

  const signRequest = {
    agentId,
    tenantId,
    to: toAddress,
    value: txValue,
    chainId,
  };

  const policySet = await getPolicySet(tenantId, agentId);

  // ── Redis rate-limit check (Solana) ────────────────────────────────────────
  const solRlResult = await enforceRateLimit(agentId, policySet);
  if (!solRlResult.allowed) {
    if (solRlResult.headers) {
      for (const [key, value] of Object.entries(solRlResult.headers)) {
        c.header(key, value);
      }
    }
    return c.json<ApiResponse>(
      { ok: false, error: solRlResult.reason || "Rate limit exceeded" },
      429,
    );
  }

  const stats = await getTransactionStats(agentId);

  const evaluation = await policyEngine.evaluate(policySet, {
    request: signRequest,
    recentTxCount1h: stats.recentTxCount1h,
    recentTxCount24h: stats.recentTxCount24h,
    spentToday: stats.spentToday,
    spentThisWeek: stats.spentThisWeek,
    priceOracle,
  });

  if (!evaluation.approved) {
    const txId = crypto.randomUUID();

    if (evaluation.requiresManualApproval) {
      await db.transaction(async (tx) => {
        await tx.insert(transactions).values({
          id: txId,
          agentId,
          status: "pending",
          toAddress,
          value: txValue,
          data: body.transaction,
          chainId,
          policyResults: evaluation.results,
        });
        await tx.insert(approvalQueue).values({
          id: crypto.randomUUID(),
          txId,
          agentId,
          status: "pending",
        });
      });

      dispatchWebhook(tenantId, agentId, "approval_required", {
        txId,
        results: evaluation.results,
      });

      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Transaction requires manual approval",
          data: {
            txId,
            results: evaluation.results,
            status: "pending_approval",
          },
        },
        202,
      );
    }

    await db.insert(transactions).values({
      id: txId,
      agentId,
      status: "rejected",
      toAddress,
      value: txValue,
      chainId,
      policyResults: evaluation.results,
    });

    dispatchWebhook(tenantId, agentId, "tx_rejected", {
      txId,
      results: evaluation.results,
    });

    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction rejected by policy",
        data: { txId, results: evaluation.results },
      },
      403,
    );
  }

  try {
    const txId = crypto.randomUUID();

    const result = await vault.signSolanaTransaction({
      agentId,
      tenantId,
      transaction: body.transaction,
      chainId,
      broadcast: body.broadcast,
    });

    await db.insert(transactions).values({
      id: txId,
      agentId,
      status: "signed",
      toAddress,
      value: txValue,
      chainId,
      txHash: result.broadcast ? result.signature : undefined,
      policyResults: evaluation.results,
      signedAt: new Date(),
    });

    // ── Record spend in Redis (fire-and-forget) ──────────────────────────────
    recordVaultSpend(agentId, tenantId, txValue, chainId).catch((err) =>
      console.error("[vault] Failed to record Solana spend:", err),
    );

    dispatchWebhook(tenantId, agentId, "tx_signed", {
      txId,
      txHash: result.broadcast ? result.signature : undefined,
    });

    return c.json<
      ApiResponse<{
        txId: string;
        signature: string;
        broadcast: boolean;
        chainId: number;
        caip2?: string;
      }>
    >({
      ok: true,
      data: { txId, ...result },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    console.error(`[${requestId}] Solana sign failed for agent ${agentId}:`, e);

    dispatchWebhook(tenantId, agentId, "tx_failed", {
      error: e instanceof Error ? e.message : "Unknown error",
      requestId,
    });

    if (isRpcError(e)) {
      return c.json<ApiResponse>({ ok: false, error: extractRpcErrorMessage(e) }, 502);
    }
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

// ─── Generic RPC Passthrough ──────────────────────────────────────────────────

vaultRoutes.post("/:agentId/rpc", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<RpcRequest>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.method)) {
    return c.json<ApiResponse>({ ok: false, error: "'method' is required" }, 400);
  }

  if (!body.chainId || typeof body.chainId !== "number") {
    return c.json<ApiResponse>(
      { ok: false, error: "'chainId' is required and must be a number" },
      400,
    );
  }

  try {
    const result = await vault.rpcPassthrough(body);
    return c.json<ApiResponse<RpcResponse>>({
      ok: true,
      data: result,
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error(`[${requestId}] RPC passthrough failed for agent ${agentId}:`, e);
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

// ─── Multi-Wallet Address List ────────────────────────────────────────────────

vaultRoutes.get("/:agentId/addresses", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  try {
    const addresses = await vault.getAddresses(tenantId, agentId);
    return c.json<
      ApiResponse<{
        agentId: string;
        addresses: Array<{ chainFamily: "evm" | "solana"; address: string }>;
      }>
    >({
      ok: true,
      data: { agentId, addresses },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    console.error(`[${requestId}] getAddresses failed for agent ${agentId}:`, e);
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

// ─── Key Import ───────────────────────────────────────────────────────────────

vaultRoutes.post("/:agentId/import", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Key import requires tenant-level authentication" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");

  if (!isValidAgentId(agentId)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Invalid agent id — must be 1-128 alphanumeric characters (plus _ - . :)",
      },
      400,
    );
  }

  const body = await safeJsonParse<{
    privateKey: string;
    chain: "evm" | "solana";
  }>(c);
  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.privateKey)) {
    return c.json<ApiResponse>({ ok: false, error: "privateKey is required" }, 400);
  }

  if (body.chain !== "evm" && body.chain !== "solana") {
    return c.json<ApiResponse>({ ok: false, error: "chain must be 'evm' or 'solana'" }, 400);
  }

  try {
    const result = await vault.importKey(tenantId, agentId, body.privateKey, body.chain);
    return c.json<ApiResponse<{ agentId: string; walletAddress: string; chain: string }>>({
      ok: true,
      data: { agentId, walletAddress: result.walletAddress, chain: body.chain },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    console.error(`[${requestId}] Key import failed for agent ${agentId}:`, e);
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

// ─── Key Export ──────────────────────────────────────────────────────────

vaultRoutes.post("/:agentId/export", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Key export requires tenant-level authentication" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  try {
    const keys = await vault.exportPrivateKey(tenantId, agentId);

    return c.json<
      ApiResponse<{
        evm?: { privateKey: string; address: string };
        solana?: { privateKey: string; address: string };
        warning: string;
      }>
    >({
      ok: true,
      data: {
        ...keys,
        warning: "This key controls real funds. Store securely.",
      },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    console.error(`[${requestId}] Key export failed for agent ${agentId}:`, e);
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

// ─── Webhook dispatch helper ──────────────────────────────────────────────────

type WebhookEventType =
  | "approval_required"
  | "tx_signed"
  | "tx_confirmed"
  | "tx_failed"
  | "tx_rejected";

function dispatchWebhook(
  tenantId: string,
  agentId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
) {
  const webhookUrl = tenantConfigs.get(tenantId)?.webhookUrl;
  if (webhookUrl) {
    webhookDispatcher
      .dispatch({ type, tenantId, agentId, data, timestamp: new Date() }, webhookUrl)
      .catch(console.error);
  }
}
