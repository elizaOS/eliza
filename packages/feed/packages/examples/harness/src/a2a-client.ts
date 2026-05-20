/**
 * A2A Client for Harness
 *
 * Connects to local A2A server and provides all required methods.
 */

import { ethers } from "ethers";
import type {
  A2AClientInterface,
  AgentInfo,
  LeaderboardEntry,
  Market,
  Notification,
  Position,
  Post,
  SystemStats,
  Trade,
  UserInfo,
} from "./types";

export interface A2AClientConfig {
  baseUrl: string;
  privateKey: string;
}

export class HarnessA2AClient implements A2AClientInterface {
  private baseUrl: string;
  private address: string;
  private tokenId: number;
  private agentId: string;
  private messageId = 1;

  constructor(config: A2AClientConfig) {
    this.baseUrl = config.baseUrl;

    const wallet = new ethers.Wallet(config.privateKey);
    this.address = wallet.address;
    this.tokenId = Math.floor(Date.now() / 1000) % 1000000;
    this.agentId = `agent-31337-${this.tokenId}`;
  }

  getAgentId(): string {
    return this.agentId;
  }

  getAddress(): string {
    return this.address;
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-id": this.agentId,
        "x-agent-address": this.address,
        "x-agent-token-id": this.tokenId.toString(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: this.messageId++,
      }),
    });

    const data = (await response.json()) as {
      error?: { message: string };
      result: T;
    };

    if (data.error) {
      throw new Error(`A2A Error: ${data.error.message}`);
    }

    return data.result;
  }

  // ===== Registration =====

  async register(
    displayName: string,
    description: string,
  ): Promise<{ success: boolean; agent: { id: string } }> {
    return this.call("register", {
      walletAddress: this.address,
      tokenId: this.tokenId,
      chainId: 31337,
      displayName,
      description,
    });
  }

  // ===== Portfolio =====

  async getBalance(): Promise<{ balance: number; currency: string }> {
    return this.call("getBalance", {});
  }

  async getPositions(): Promise<{ positions: Position[] }> {
    return this.call("getPositions", {});
  }

  async getPortfolio(): Promise<{
    balance: number;
    positions: Position[];
    pnl: number;
  }> {
    return this.call("getPortfolio", {});
  }

  // ===== Markets =====

  async getMarkets(): Promise<{ predictions: Market[]; perps: Market[] }> {
    return this.call("getMarkets", {});
  }

  async getMarketData(marketId: string): Promise<Market> {
    return this.call("getMarketData", { marketId });
  }

  async buyShares(
    marketId: string,
    outcome: "YES" | "NO",
    amount: number,
  ): Promise<Trade> {
    return this.call("buyShares", { marketId, outcome, amount });
  }

  async sellShares(
    marketId: string,
    outcome: "YES" | "NO",
    shares: number,
  ): Promise<Trade> {
    return this.call("sellShares", { marketId, outcome, shares });
  }

  // ===== Social =====

  async getFeed(limit: number = 20): Promise<{ posts: Post[] }> {
    return this.call("getFeed", { limit });
  }

  async createPost(content: string): Promise<Post> {
    return this.call("createPost", { content });
  }

  async likePost(
    postId: string,
  ): Promise<{ success: boolean; likesCount: number }> {
    return this.call("likePost", { postId });
  }

  async commentPost(postId: string, content: string): Promise<{ id: string }> {
    return this.call("commentPost", { postId, content });
  }

  // ===== Discovery =====

  async discover(): Promise<{ agents: AgentInfo[] }> {
    return this.call("discover", {});
  }

  async searchUsers(query: string): Promise<{ users: UserInfo[] }> {
    return this.call("searchUsers", { query });
  }

  // ===== Stats =====

  async getStats(): Promise<SystemStats> {
    return this.call("getStats", {});
  }

  async getLeaderboard(
    limit: number = 10,
  ): Promise<{ entries: LeaderboardEntry[] }> {
    return this.call("getLeaderboard", { limit });
  }

  // ===== Notifications =====

  async getNotifications(): Promise<{ notifications: Notification[] }> {
    return this.call("getNotifications", {});
  }

  async markNotificationRead(
    notificationId: string,
  ): Promise<{ success: boolean }> {
    return this.call("markNotificationRead", { notificationId });
  }
}
