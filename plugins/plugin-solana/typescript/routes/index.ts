import type { Route } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { SOLANA_WALLET_DATA_CACHE_KEY } from "../constants";
import type { SolanaService } from "../service";
import type { ApiError, ApiResponse, WalletPortfolio } from "../types";

type RouteHandler = NonNullable<Route["handler"]>;

function sendSuccess<T>(res: Parameters<RouteHandler>[1], data: T, status = 200): void {
  const response: ApiResponse<T> = { success: true, data };
  res.status(status).json(response);
}

function sendError(
  res: Parameters<RouteHandler>[1],
  status: number,
  code: string,
  message: string,
  details?: string
): void {
  const error: ApiError = details !== undefined ? { code, message, details } : { code, message };
  const response: ApiResponse<never> = { success: false, error };
  res.status(status).json(response);
}

const getWalletAddressHandler: RouteHandler = async (_req, res, runtime) => {
  const solanaService = runtime.getService<SolanaService>("chain_solana");

  if (!solanaService) {
    sendError(res, 500, "SERVICE_NOT_FOUND", "SolanaService not found");
    return;
  }

  try {
    const publicKey = await solanaService.getPublicKey();

    if (!publicKey) {
      sendError(res, 404, "NO_WALLET", "No wallet configured");
      return;
    }

    sendSuccess(res, {
      publicKey: publicKey.toBase58(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Route] Failed to get wallet address:", errorMessage);
    sendError(res, 500, "ERROR", "Failed to get wallet address", errorMessage);
  }
};

const getWalletBalanceHandler: RouteHandler = async (_req, res, runtime) => {
  const solanaService = runtime.getService<SolanaService>("chain_solana");

  if (!solanaService) {
    sendError(res, 500, "SERVICE_NOT_FOUND", "SolanaService not found");
    return;
  }

  try {
    const publicKey = await solanaService.getPublicKey();

    if (!publicKey) {
      sendError(res, 404, "NO_WALLET", "No wallet configured");
      return;
    }

    const publicKeyStr = publicKey.toBase58();
    const balances = await solanaService.getBalancesByAddrs([publicKeyStr]);
    const balance = balances[publicKeyStr] ?? 0;

    sendSuccess(res, {
      publicKey: publicKeyStr,
      balance: balance,
      symbol: "SOL",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Route] Failed to get wallet balance:", errorMessage);
    sendError(res, 500, "ERROR", "Failed to get wallet balance", errorMessage);
  }
};

const getTokenBalanceHandler: RouteHandler = async (req, res, runtime) => {
  const token = req.params?.token;
  const solanaService = runtime.getService<SolanaService>("chain_solana");

  if (!solanaService) {
    sendError(res, 500, "SERVICE_NOT_FOUND", "SolanaService not found");
    return;
  }

  if (!token) {
    sendError(res, 400, "INVALID_REQUEST", "token parameter is required");
    return;
  }

  try {
    const publicKey = await solanaService.getPublicKey();

    if (!publicKey) {
      sendError(res, 404, "NO_WALLET", "No wallet configured");
      return;
    }

    const publicKeyStr = publicKey.toBase58();

    // Get all token accounts and find the one matching the requested mint
    const tokenAccounts = await solanaService.getTokenAccountsByKeypair(publicKey, {
      includeZeroBalances: false,
    });

    const matchingToken = tokenAccounts.find((acc) => acc.account.data.parsed.info.mint === token);

    if (!matchingToken) {
      sendError(res, 404, "TOKEN_NOT_FOUND", `Token ${token} not found in wallet`);
      return;
    }

    const balance = matchingToken.account.data.parsed.info.tokenAmount.uiAmount;

    sendSuccess(res, {
      publicKey: publicKeyStr,
      token: token,
      balance: balance,
      decimals: matchingToken.account.data.parsed.info.tokenAmount.decimals,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Route] Failed to get token balance:", errorMessage);
    sendError(res, 500, "ERROR", "Failed to get token balance", errorMessage);
  }
};

const getWalletPortfolioHandler: RouteHandler = async (_req, res, runtime) => {
  const solanaService = runtime.getService<SolanaService>("chain_solana");

  if (!solanaService) {
    sendError(res, 500, "SERVICE_NOT_FOUND", "SolanaService not found");
    return;
  }

  try {
    const publicKey = await solanaService.getPublicKey();

    if (!publicKey) {
      sendError(res, 404, "NO_WALLET", "No wallet configured");
      return;
    }

    const portfolioCache = await runtime.getCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY);

    if (!portfolioCache) {
      logger.info("[Route] Portfolio cache empty, triggering update");
      const portfolio = await solanaService.updateWalletData(true);

      sendSuccess(res, {
        publicKey: publicKey.toBase58(),
        totalUsd: portfolio.totalUsd,
        totalSol: portfolio.totalSol || "0",
        tokens: portfolio.items.map((item) => ({
          name: item.name,
          symbol: item.symbol,
          address: item.address,
          balance: item.uiAmount,
          decimals: item.decimals,
          priceUsd: item.priceUsd,
          valueUsd: item.valueUsd,
          valueSol: item.valueSol,
        })),
        prices: portfolio.prices,
        lastUpdated: portfolio.lastUpdated,
        hasBirdeyeData: portfolio.prices !== undefined,
      });
      return;
    }

    const portfolio = portfolioCache;

    sendSuccess(res, {
      publicKey: publicKey.toBase58(),
      totalUsd: portfolio.totalUsd,
      totalSol: portfolio.totalSol || "0",
      tokens: portfolio.items.map((item) => ({
        name: item.name,
        symbol: item.symbol,
        address: item.address,
        balance: item.uiAmount,
        decimals: item.decimals,
        priceUsd: item.priceUsd,
        valueUsd: item.valueUsd,
        valueSol: item.valueSol,
      })),
      prices: portfolio.prices,
      lastUpdated: portfolio.lastUpdated,
      hasBirdeyeData: portfolio.prices !== undefined,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Route] Failed to get wallet portfolio:", errorMessage);
    sendError(res, 500, "ERROR", "Failed to get wallet portfolio", errorMessage);
  }
};

const getWalletTokensHandler: RouteHandler = async (_req, res, runtime) => {
  const solanaService = runtime.getService<SolanaService>("chain_solana");

  if (!solanaService) {
    sendError(res, 500, "SERVICE_NOT_FOUND", "SolanaService not found");
    return;
  }

  try {
    const publicKey = await solanaService.getPublicKey();

    if (!publicKey) {
      sendError(res, 404, "NO_WALLET", "No wallet configured");
      return;
    }

    const tokenAccounts = await solanaService.getTokenAccountsByKeypair(publicKey, {
      includeZeroBalances: false,
    });

    const tokens = tokenAccounts.map((acc) => {
      const info = acc.account.data.parsed.info;
      return {
        mint: info.mint,
        balance: info.tokenAmount.uiAmount,
        decimals: info.tokenAmount.decimals,
        amount: info.tokenAmount.amount,
      };
    });

    sendSuccess(res, {
      publicKey: publicKey.toBase58(),
      tokens: tokens,
      count: tokens.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Route] Failed to get wallet tokens:", errorMessage);
    sendError(res, 500, "ERROR", "Failed to get wallet tokens", errorMessage);
  }
};

export const solanaRoutes: Route[] = [
  {
    type: "GET",
    path: "/wallet/address",
    handler: getWalletAddressHandler,
  },
  {
    type: "GET",
    path: "/wallet/balance",
    handler: getWalletBalanceHandler,
  },
  {
    type: "GET",
    path: "/wallet/balance/:token",
    handler: getTokenBalanceHandler,
  },
  {
    type: "GET",
    path: "/wallet/portfolio",
    handler: getWalletPortfolioHandler,
  },
  {
    type: "GET",
    path: "/wallet/tokens",
    handler: getWalletTokensHandler,
  },
];
