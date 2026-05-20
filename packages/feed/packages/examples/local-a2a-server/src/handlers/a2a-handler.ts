/**
 * A2A Protocol Handler
 * Routes A2A methods to appropriate handlers
 */

import type { AgentRegistry } from '../services/agent-registry';
import type { MarketHandler } from './market-handler';
import type { PortfolioHandler } from './portfolio-handler';
import type { SocialHandler } from './social-handler';

interface AgentContext {
  agentId?: string;
  address?: string;
  tokenId?: number;
}

interface A2AError extends Error {
  code: number;
  data?: unknown;
}

function createError(code: number, message: string, data?: unknown): A2AError {
  const error = new Error(message) as A2AError;
  error.code = code;
  error.data = data;
  return error;
}

export class A2AHandler {
  constructor(
    private agentRegistry: AgentRegistry,
    private marketHandler: MarketHandler,
    private socialHandler: SocialHandler,
    private portfolioHandler: PortfolioHandler
  ) {}

  /**
   * Handle A2A JSON-RPC method
   */
  async handleMethod(
    method: string,
    params: Record<string, unknown>,
    context: AgentContext
  ): Promise<unknown> {
    // Auto-register agent if they have address and tokenId
    if (context.address && context.tokenId) {
      await this.agentRegistry.getOrCreateAgent(
        context.address,
        context.tokenId
      );
    }

    switch (method) {
      // ==================== Agent Discovery ====================
      case 'a2a.discover':
      case 'discover':
        return this.discover(params);

      case 'a2a.getInfo':
      case 'getInfo':
        return this.getAgentInfo(params.agentId as string);

      case 'a2a.register':
      case 'register':
        return this.registerAgent(params, context);

      // ==================== Portfolio ====================
      case 'a2a.getBalance':
      case 'getBalance':
        return this.portfolioHandler.getBalance(
          context.agentId || context.address!
        );

      case 'a2a.getPositions':
      case 'getPositions':
        return this.portfolioHandler.getPositions(
          context.agentId || context.address!
        );

      case 'a2a.getPortfolio':
      case 'getPortfolio':
        return this.portfolioHandler.getPortfolio(
          context.agentId || context.address!
        );

      case 'a2a.getUserWallet':
      case 'getUserWallet':
        return this.portfolioHandler.getWalletInfo(
          context.agentId || context.address!
        );

      // ==================== Markets ====================
      case 'a2a.getMarkets':
      case 'getMarkets':
        return this.marketHandler.getMarkets(params);

      case 'a2a.getMarketData':
      case 'getMarketData':
        return this.marketHandler.getMarketData(params.marketId as string);

      case 'a2a.getMarketPrices':
      case 'getMarketPrices':
        return this.marketHandler.getMarketPrices(params.marketIds as string[]);

      case 'a2a.buyShares':
      case 'buyShares':
        return this.marketHandler.buyShares(
          context.agentId || context.address!,
          params.marketId as string,
          params.outcome as 'YES' | 'NO',
          params.amount as number
        );

      case 'a2a.sellShares':
      case 'sellShares':
        return this.marketHandler.sellShares(
          context.agentId || context.address!,
          params.marketId as string,
          params.outcome as 'YES' | 'NO',
          params.shares as number
        );

      // ==================== Social ====================
      case 'a2a.getFeed':
      case 'getFeed':
        return this.socialHandler.getFeed(params);

      case 'a2a.createPost':
      case 'createPost':
        return this.socialHandler.createPost(
          context.agentId || context.address!,
          params.content as string,
          params.mediaUrls as string[] | undefined
        );

      case 'a2a.getPost':
      case 'getPost':
        return this.socialHandler.getPost(params.postId as string);

      case 'a2a.likePost':
      case 'likePost':
        return this.socialHandler.likePost(
          context.agentId || context.address!,
          params.postId as string
        );

      case 'a2a.commentPost':
      case 'commentPost':
        return this.socialHandler.commentPost(
          context.agentId || context.address!,
          params.postId as string,
          params.content as string
        );

      case 'a2a.searchUsers':
      case 'searchUsers':
        return this.socialHandler.searchUsers(params.query as string);

      // ==================== Notifications ====================
      case 'a2a.getNotifications':
      case 'getNotifications':
        return this.socialHandler.getNotifications(
          context.agentId || context.address!,
          params
        );

      case 'a2a.markNotificationRead':
      case 'markNotificationRead':
        return this.socialHandler.markNotificationRead(
          context.agentId || context.address!,
          params.notificationId as string
        );

      // ==================== Stats ====================
      case 'a2a.getStats':
      case 'getStats':
        return this.getSystemStats();

      case 'a2a.getLeaderboard':
      case 'getLeaderboard':
        return this.portfolioHandler.getLeaderboard(params);

      // ==================== Payments (x402) ====================
      case 'a2a.paymentRequest':
      case 'paymentRequest':
        return this.createPaymentRequest(params, context);

      case 'a2a.paymentReceipt':
      case 'paymentReceipt':
        return this.submitPaymentReceipt(params, context);

      default:
        throw createError(-32601, `Method not found: ${method}`);
    }
  }

  private async discover(params: Record<string, unknown>): Promise<unknown> {
    const agents = this.agentRegistry.discoverAgents({
      verified: params.verified as boolean | undefined,
      search: params.search as string | undefined,
      limit: params.limit as number | undefined,
    });

    return {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.displayName,
        description: a.description,
        isVerified: a.isVerified,
        walletAddress: a.walletAddress,
      })),
    };
  }

  private getAgentInfo(agentId: string): unknown {
    const agent = this.agentRegistry.getAgent(agentId);
    if (!agent) {
      throw createError(-32602, `Agent not found: ${agentId}`);
    }

    return {
      id: agent.id,
      name: agent.displayName,
      description: agent.description,
      walletAddress: agent.walletAddress,
      tokenId: agent.tokenId,
      chainId: agent.chainId,
      isVerified: agent.isVerified,
      createdAt: agent.createdAt.toISOString(),
    };
  }

  private async registerAgent(
    params: Record<string, unknown>,
    context: AgentContext
  ): Promise<unknown> {
    const agent = await this.agentRegistry.registerAgent({
      walletAddress: (params.walletAddress as string) || context.address!,
      tokenId: (params.tokenId as number) || context.tokenId!,
      chainId: (params.chainId as number) || 31337,
      displayName: params.displayName as string | undefined,
      description: params.description as string | undefined,
      avatarUrl: params.avatarUrl as string | undefined,
      metadata: params.metadata as Record<string, unknown> | undefined,
    });

    return {
      success: true,
      agent: {
        id: agent.id,
        name: agent.displayName,
        isVerified: agent.isVerified,
      },
    };
  }

  private async getSystemStats(): Promise<unknown> {
    const agentCount = this.agentRegistry.getAgentCount();
    const marketStats = this.marketHandler.getMarketStats();
    const socialStats = this.socialHandler.getSocialStats();

    return {
      totalAgents: agentCount,
      totalUsers: socialStats.totalUsers,
      totalMarkets: marketStats.totalMarkets,
      totalVolume: marketStats.totalVolume,
      totalPosts: socialStats.totalPosts,
      totalTrades: marketStats.totalTrades,
      timestamp: new Date().toISOString(),
    };
  }

  private async createPaymentRequest(
    params: Record<string, unknown>,
    context: AgentContext
  ): Promise<unknown> {
    // x402 payment request
    return {
      paymentId: `pay-${Date.now()}`,
      amount: params.amount,
      currency: params.currency || 'ETH',
      recipient: context.address,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      status: 'pending',
    };
  }

  private async submitPaymentReceipt(
    params: Record<string, unknown>,
    context: AgentContext
  ): Promise<unknown> {
    // x402 payment receipt verification
    return {
      paymentId: params.paymentId,
      verified: true,
      amount: params.amount,
      transactionHash: params.transactionHash,
      timestamp: new Date().toISOString(),
    };
  }
}
