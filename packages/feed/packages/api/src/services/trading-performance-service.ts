import { buildCapitalBaseContributionSql, db, sql } from '@babylon/db';
import { toISO } from '@babylon/shared';

export const TRADING_RETURN_CAPITAL_FLOOR = 1000;

function buildCapitalContributionExpression(
  transactionAlias: string,
  scope: 'wallet' | 'team'
): string {
  return buildCapitalBaseContributionSql(transactionAlias, scope);
}

export interface TradingReturnMetrics {
  capitalBase: number;
  effectiveCapitalBase: number;
  tradingReturn: number;
}

export interface WalletTradingPerformanceRow {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  reputationPoints: string;
  balance: string;
  lifetimePnL: string;
  capitalBase: string;
  effectiveCapitalBase: string;
  tradingReturn: string;
  createdAt: Date | string;
  nftTokenId: number | null;
  isAgent: boolean;
  managedBy: string | null;
}

export interface TeamTradingPerformanceRow {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  reputationPoints: string;
  balance: string;
  userLifetimePnL: string;
  agentLifetimePnL: string;
  teamLifetimePnL: string;
  teamCapitalBase: string;
  teamEffectiveCapitalBase: string;
  teamTradingReturn: string;
  createdAt: Date | string;
  nftTokenId: number | null;
  agentCount: number;
}

export class TradingPerformanceService {
  static calculateTradingReturnMetrics(
    lifetimePnL: number,
    capitalBase: number
  ): TradingReturnMetrics {
    const normalizedCapitalBase = Math.max(capitalBase, 0);
    const effectiveCapitalBase = Math.max(
      normalizedCapitalBase,
      TRADING_RETURN_CAPITAL_FLOOR
    );

    return {
      capitalBase: normalizedCapitalBase,
      effectiveCapitalBase,
      tradingReturn: lifetimePnL / effectiveCapitalBase,
    };
  }

  private static walletCapitalCte() {
    return sql.raw(`
      SELECT
        bt."userId" AS "userId",
        GREATEST(
          COALESCE(SUM(${buildCapitalContributionExpression('bt', 'wallet')}), 0),
          0
        )::numeric AS "capitalBase"
      FROM "BalanceTransaction" bt
      GROUP BY bt."userId"
    `);
  }

  private static teamCapitalCte() {
    return sql.raw(`
      SELECT
        COALESCE(u."managedBy", u."id") AS "teamId",
        GREATEST(
          COALESCE(SUM(${buildCapitalContributionExpression('bt', 'team')}), 0),
          0
        )::numeric AS "teamCapitalBase"
      FROM "BalanceTransaction" bt
      INNER JOIN "User" u ON u."id" = bt."userId"
      WHERE u."isActor" = false
      GROUP BY COALESCE(u."managedBy", u."id")
    `);
  }

  private static teamAgentsCte() {
    return sql.raw(`
      SELECT
        "managedBy" AS "managerId",
        COALESCE(SUM("lifetimePnL"::numeric), 0)::numeric AS "agentLifetimePnL",
        COUNT(*)::int AS "agentCount"
      FROM "User"
      WHERE "isAgent" = true AND "isActor" = false
      GROUP BY "managedBy"
    `);
  }

  static async getWalletLeaderboardRows(
    limit: number,
    offset: number
  ): Promise<WalletTradingPerformanceRow[]> {
    const result = await db.execute(sql`
      WITH wallet_capital AS (${this.walletCapitalCte()})
      SELECT
        u."id",
        u."username",
        u."displayName",
        u."profileImageUrl",
        u."reputationPoints"::numeric AS "reputationPoints",
        u."virtualBalance"::numeric AS "balance",
        u."lifetimePnL"::numeric AS "lifetimePnL",
        COALESCE(wc."capitalBase", 0)::numeric AS "capitalBase",
        GREATEST(
          COALESCE(wc."capitalBase", 0)::numeric,
          ${TRADING_RETURN_CAPITAL_FLOOR}
        )::numeric AS "effectiveCapitalBase",
        (
          u."lifetimePnL"::numeric /
          GREATEST(
            COALESCE(wc."capitalBase", 0)::numeric,
            ${TRADING_RETURN_CAPITAL_FLOOR}
          )
        )::numeric AS "tradingReturn",
        u."createdAt",
        u."nftTokenId",
        u."isAgent",
        u."managedBy"
      FROM "User" u
      LEFT JOIN wallet_capital wc ON wc."userId" = u."id"
      WHERE u."isActor" = false
      ORDER BY "tradingReturn" DESC, u."createdAt" ASC, u."id" ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return result as unknown as WalletTradingPerformanceRow[];
  }

  static async getWalletEntry(
    userId: string
  ): Promise<WalletTradingPerformanceRow | null> {
    const result = await db.execute(sql`
      WITH wallet_capital AS (${this.walletCapitalCte()})
      SELECT
        u."id",
        u."username",
        u."displayName",
        u."profileImageUrl",
        u."reputationPoints"::numeric AS "reputationPoints",
        u."virtualBalance"::numeric AS "balance",
        u."lifetimePnL"::numeric AS "lifetimePnL",
        COALESCE(wc."capitalBase", 0)::numeric AS "capitalBase",
        GREATEST(
          COALESCE(wc."capitalBase", 0)::numeric,
          ${TRADING_RETURN_CAPITAL_FLOOR}
        )::numeric AS "effectiveCapitalBase",
        (
          u."lifetimePnL"::numeric /
          GREATEST(
            COALESCE(wc."capitalBase", 0)::numeric,
            ${TRADING_RETURN_CAPITAL_FLOOR}
          )
        )::numeric AS "tradingReturn",
        u."createdAt",
        u."nftTokenId",
        u."isAgent",
        u."managedBy"
      FROM "User" u
      LEFT JOIN wallet_capital wc ON wc."userId" = u."id"
      WHERE u."isActor" = false AND u."id" = ${userId}
      LIMIT 1
    `);

    const rows = result as unknown as WalletTradingPerformanceRow[];
    return rows[0] ?? null;
  }

  static async countWalletsAbove(entry: {
    id: string;
    createdAt: Date | string;
    tradingReturn: string;
  }): Promise<number> {
    const createdAtISO = toISO(entry.createdAt);
    const result = await db.execute(sql`
      WITH wallet_capital AS (${this.walletCapitalCte()}),
      wallet_rows AS (
        SELECT
          u."id",
          u."createdAt",
          (
            u."lifetimePnL"::numeric /
            GREATEST(
              COALESCE(wc."capitalBase", 0)::numeric,
              ${TRADING_RETURN_CAPITAL_FLOOR}
            )
          )::numeric AS "tradingReturn"
        FROM "User" u
        LEFT JOIN wallet_capital wc ON wc."userId" = u."id"
        WHERE u."isActor" = false
      )
      SELECT COUNT(*)::int AS "count"
      FROM wallet_rows wr
      WHERE
        wr."tradingReturn" > ${entry.tradingReturn}
        OR (
          wr."tradingReturn" = ${entry.tradingReturn}
          AND (
            wr."createdAt" < ${createdAtISO}
            OR (
              wr."createdAt" = ${createdAtISO}
              AND wr."id" < ${entry.id}
            )
          )
        )
    `);

    const rows = result as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  static async getTeamLeaderboardRows(
    limit: number,
    offset: number
  ): Promise<TeamTradingPerformanceRow[]> {
    const result = await db.execute(sql`
      WITH team_capital AS (${this.teamCapitalCte()}),
      team_agents AS (${this.teamAgentsCte()})
      SELECT
        u."id",
        u."username",
        u."displayName",
        u."profileImageUrl",
        u."reputationPoints"::numeric AS "reputationPoints",
        u."virtualBalance"::numeric AS "balance",
        u."lifetimePnL"::numeric AS "userLifetimePnL",
        COALESCE(ta."agentLifetimePnL", 0)::numeric AS "agentLifetimePnL",
        (
          u."lifetimePnL"::numeric + COALESCE(ta."agentLifetimePnL", 0)
        )::numeric AS "teamLifetimePnL",
        COALESCE(tc."teamCapitalBase", 0)::numeric AS "teamCapitalBase",
        GREATEST(
          COALESCE(tc."teamCapitalBase", 0)::numeric,
          ${TRADING_RETURN_CAPITAL_FLOOR}
        )::numeric AS "teamEffectiveCapitalBase",
        (
          (
            u."lifetimePnL"::numeric + COALESCE(ta."agentLifetimePnL", 0)
          ) /
          GREATEST(
            COALESCE(tc."teamCapitalBase", 0)::numeric,
            ${TRADING_RETURN_CAPITAL_FLOOR}
          )
        )::numeric AS "teamTradingReturn",
        u."createdAt",
        u."nftTokenId",
        COALESCE(ta."agentCount", 0)::int AS "agentCount"
      FROM "User" u
      LEFT JOIN team_agents ta ON ta."managerId" = u."id"
      LEFT JOIN team_capital tc ON tc."teamId" = u."id"
      WHERE u."isActor" = false AND u."isAgent" = false
      ORDER BY "teamTradingReturn" DESC, u."createdAt" ASC, u."id" ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return result as unknown as TeamTradingPerformanceRow[];
  }

  static async getTeamEntry(
    teamOwnerId: string
  ): Promise<TeamTradingPerformanceRow | null> {
    const result = await db.execute(sql`
      WITH team_capital AS (${this.teamCapitalCte()}),
      team_agents AS (${this.teamAgentsCte()})
      SELECT
        u."id",
        u."username",
        u."displayName",
        u."profileImageUrl",
        u."reputationPoints"::numeric AS "reputationPoints",
        u."virtualBalance"::numeric AS "balance",
        u."lifetimePnL"::numeric AS "userLifetimePnL",
        COALESCE(ta."agentLifetimePnL", 0)::numeric AS "agentLifetimePnL",
        (
          u."lifetimePnL"::numeric + COALESCE(ta."agentLifetimePnL", 0)
        )::numeric AS "teamLifetimePnL",
        COALESCE(tc."teamCapitalBase", 0)::numeric AS "teamCapitalBase",
        GREATEST(
          COALESCE(tc."teamCapitalBase", 0)::numeric,
          ${TRADING_RETURN_CAPITAL_FLOOR}
        )::numeric AS "teamEffectiveCapitalBase",
        (
          (
            u."lifetimePnL"::numeric + COALESCE(ta."agentLifetimePnL", 0)
          ) /
          GREATEST(
            COALESCE(tc."teamCapitalBase", 0)::numeric,
            ${TRADING_RETURN_CAPITAL_FLOOR}
          )
        )::numeric AS "teamTradingReturn",
        u."createdAt",
        u."nftTokenId",
        COALESCE(ta."agentCount", 0)::int AS "agentCount"
      FROM "User" u
      LEFT JOIN team_agents ta ON ta."managerId" = u."id"
      LEFT JOIN team_capital tc ON tc."teamId" = u."id"
      WHERE u."isActor" = false AND u."isAgent" = false AND u."id" = ${teamOwnerId}
      LIMIT 1
    `);

    const rows = result as unknown as TeamTradingPerformanceRow[];
    return rows[0] ?? null;
  }

  static async countTeamsAbove(entry: {
    id: string;
    createdAt: Date | string;
    teamTradingReturn: string;
  }): Promise<number> {
    const createdAtISO = toISO(entry.createdAt);
    const result = await db.execute(sql`
      WITH team_capital AS (${this.teamCapitalCte()}),
      team_agents AS (${this.teamAgentsCte()}),
      team_rows AS (
        SELECT
          u."id",
          u."createdAt",
          (
            (
              u."lifetimePnL"::numeric + COALESCE(ta."agentLifetimePnL", 0)
            ) /
            GREATEST(
              COALESCE(tc."teamCapitalBase", 0)::numeric,
              ${TRADING_RETURN_CAPITAL_FLOOR}
            )
          )::numeric AS "teamTradingReturn"
        FROM "User" u
        LEFT JOIN team_agents ta ON ta."managerId" = u."id"
        LEFT JOIN team_capital tc ON tc."teamId" = u."id"
        WHERE u."isActor" = false AND u."isAgent" = false
      )
      SELECT COUNT(*)::int AS "count"
      FROM team_rows tr
      WHERE
        tr."teamTradingReturn" > ${entry.teamTradingReturn}
        OR (
          tr."teamTradingReturn" = ${entry.teamTradingReturn}
          AND (
            tr."createdAt" < ${createdAtISO}
            OR (
              tr."createdAt" = ${createdAtISO}
              AND tr."id" < ${entry.id}
            )
          )
        )
    `);

    const rows = result as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }
}
