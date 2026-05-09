/**
 * Wallet OS-store, keys, and NFT compat routes.
 *
 * Handles:
 *   GET  /api/wallet/os-store  — keychain/secret-service backend status
 *   POST /api/wallet/os-store  — migrate / delete wallet secrets in OS store
 *   GET  /api/wallet/keys      — EVM + Solana keys (loopback + onboarding gate)
 *   GET  /api/wallet/nfts      — EVM NFT fetch
 */
import type http from "node:http";
import {
  type ElizaConfig,
  loadElizaConfig,
} from "@elizaos/agent/config/config";
import {
  ensureCompatApiAuthorized,
  ensureCompatSensitiveRouteAuthorized,
  getCompatApiToken,
  isDevEnvironment,
} from "@elizaos/app-core";
import {
  type CompatRuntimeState,
  isLoopbackRemoteAddress,
  readCompatJsonBody,
} from "@elizaos/app-core";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "@elizaos/app-core";
import { deriveAgentVaultId } from "@elizaos/app-core";
import {
  createNodePlatformSecureStore,
  isWalletOsStoreReadEnabled,
} from "@elizaos/app-core";
import { logger } from "@elizaos/core";
import { getWalletAddresses } from "../api/wallet";
import { fetchEvmNfts } from "../api/wallet-evm-balance";
import { resolveWalletRpcReadiness } from "../api/wallet-rpc";
import {
  deleteWalletSecretsFromOsStore,
  migrateWalletPrivateKeysToOsStore,
} from "../security/wallet-os-store-actions";
import { getStewardBridgeStatus, isStewardConfigured } from "./steward-bridge";

export async function handleWalletCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  // Quick prefix check — all routes here live under /api/wallet/
  if (!url.pathname.startsWith("/api/wallet/")) {
    return false;
  }

  // ── GET /api/wallet/os-store ─────────────────────────────────────────
  if (method === "GET" && url.pathname === "/api/wallet/os-store") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    try {
      const store = createNodePlatformSecureStore();
      const available = await store.isAvailable();
      sendJsonResponse(res, 200, {
        backend: store.backend,
        available,
        readEnabled: isWalletOsStoreReadEnabled(),
        vaultId: deriveAgentVaultId(),
      });
    } catch (err) {
      logger.warn(
        `[wallet][os-store] GET status failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonResponse(res, 500, { error: "os-store status failed" });
    }
    return true;
  }

  // ── POST /api/wallet/os-store ────────────────────────────────────────
  if (method === "POST" && url.pathname === "/api/wallet/os-store") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (!body) {
      return true;
    }

    const action = typeof body.action === "string" ? body.action.trim() : "";

    try {
      if (action === "migrate") {
        const result = await migrateWalletPrivateKeysToOsStore();
        if (result.unavailable) {
          sendJsonResponse(res, 503, {
            ok: false,
            error: "OS secret store unavailable on this host",
          });
          return true;
        }
        sendJsonResponse(res, 200, {
          ok: true,
          migrated: result.migrated,
          failed: result.failed,
        });
        return true;
      }
      if (action === "delete") {
        await deleteWalletSecretsFromOsStore();
        sendJsonResponse(res, 200, { ok: true });
        return true;
      }
    } catch (err) {
      logger.warn(
        `[wallet][os-store] POST failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonResponse(res, 500, {
        error: err instanceof Error ? err.message : "os-store action failed",
      });
      return true;
    }

    sendJsonResponse(res, 400, { error: "Unknown action" });
    return true;
  }

  // ── GET /api/wallet/keys (onboarding only, loopback only) ────────────
  // Security note: this compat route exists only for the embedded desktop
  // onboarding flow, where the renderer needs to display the keys already
  // generated inside the local runtime. Electrobun injects a loopback
  // `http://127.0.0.1:<port>` API base plus a generated API token before the
  // renderer mounts, and ensureCompatSensitiveRouteAuthorized fails closed if
  // that token is missing. The route is also permanently disabled once
  // onboardingComplete flips true so the backup screen cannot be reopened as a
  // general-purpose key export endpoint.
  if (method === "GET" && url.pathname === "/api/wallet/keys") {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      sendJsonErrorResponse(res, 403, "loopback only");
      return true;
    }

    // In production without a configured token, reject even from loopback.
    // Electrobun injects a generated token before the renderer mounts; a
    // missing token signals the renderer has not been properly initialised.
    if (!isDevEnvironment() && !getCompatApiToken()) {
      sendJsonErrorResponse(
        res,
        403,
        "Sensitive endpoint requires API token authentication",
      );
      return true;
    }

    if (!ensureCompatSensitiveRouteAuthorized(req, res)) {
      return true;
    }

    const config = loadElizaConfig();
    if (config.meta?.onboardingComplete === true) {
      sendJsonResponse(res, 403, {
        error: "Wallet keys are only available during onboarding",
      });
      return true;
    }

    // When Steward is configured, return masked keys with Steward status
    if (isStewardConfigured()) {
      try {
        const addresses = getWalletAddresses();
        const stewardStatus = await getStewardBridgeStatus({
          evmAddress: addresses.evmAddress,
        });
        sendJsonResponse(res, 200, {
          evmPrivateKey: "[managed-by-steward]",
          evmAddress: addresses.evmAddress ?? stewardStatus.evmAddress ?? "",
          solanaPrivateKey: "[managed-by-steward]",
          solanaAddress: addresses.solanaAddress ?? "",
          steward: {
            configured: true,
            connected: stewardStatus.connected,
            agentId: stewardStatus.agentId,
          },
        });
        return true;
      } catch {
        // fall through to legacy path
      }
    }

    const evmKey = process.env.EVM_PRIVATE_KEY ?? "";
    const solKey = process.env.SOLANA_PRIVATE_KEY ?? "";

    try {
      const addresses = getWalletAddresses();
      sendJsonResponse(res, 200, {
        evmPrivateKey: evmKey,
        evmAddress: addresses.evmAddress ?? "",
        solanaPrivateKey: solKey,
        solanaAddress: addresses.solanaAddress ?? "",
      });
    } catch {
      sendJsonResponse(res, 200, {
        evmPrivateKey: evmKey,
        evmAddress: "",
        solanaPrivateKey: solKey,
        solanaAddress: "",
      });
    }
    return true;
  }

  // ── GET /api/wallet/nfts ─────────────────────────────────────────────
  if (method === "GET" && url.pathname === "/api/wallet/nfts") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const config: ElizaConfig = loadElizaConfig();
    const addresses = getWalletAddresses();
    const rpcReadiness = resolveWalletRpcReadiness(config);
    const alchemyKey = process.env.ALCHEMY_API_KEY?.trim() || null;
    const ankrKey = process.env.ANKR_API_KEY?.trim() || null;
    const result: {
      evm: Array<{ chain: string; nfts: unknown[] }>;
      solana: { nfts: unknown[] } | null;
    } = {
      evm: [],
      solana: null,
    };

    if (addresses.evmAddress && rpcReadiness.evmBalanceReady) {
      try {
        result.evm = await fetchEvmNfts(addresses.evmAddress, {
          alchemyKey,
          ankrKey,
          cloudManagedAccess: rpcReadiness.cloudManagedAccess,
          bscRpcUrls: rpcReadiness.bscRpcUrls,
          ethereumRpcUrls: rpcReadiness.ethereumRpcUrls,
          baseRpcUrls: rpcReadiness.baseRpcUrls,
          avaxRpcUrls: rpcReadiness.avalancheRpcUrls,
          nodeRealBscRpcUrl: process.env.NODEREAL_BSC_RPC_URL,
          quickNodeBscRpcUrl: process.env.QUICKNODE_BSC_RPC_URL,
          bscRpcUrl: process.env.BSC_RPC_URL,
          ethereumRpcUrl: process.env.ETHEREUM_RPC_URL,
          baseRpcUrl: process.env.BASE_RPC_URL,
          avaxRpcUrl: process.env.AVALANCHE_RPC_URL,
        });
      } catch (err) {
        logger.warn(`[wallet] EVM NFT fetch failed: ${err}`);
      }
    }

    sendJsonResponse(res, 200, result);
    return true;
  }

  return false;
}
