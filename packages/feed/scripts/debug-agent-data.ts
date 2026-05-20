#!/usr/bin/env bun

/**
 * Debug script to check agent data and trade records
 */

import { db } from '@feed/db';
import { agentTrades, perpPositions, users } from '@feed/db/schema';
import { getTimeAgo } from '@feed/shared';
import { desc, eq, sql } from 'drizzle-orm';

async function debugAgentData() {
  console.log('🔍 Debugging agent data...\n');

  try {
    // Check if there are ANY trades in AgentTrade table
    const totalTrades = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentTrades);

    console.log(
      `📊 Total trades in AgentTrade table: ${totalTrades[0].count}\n`
    );

    if (totalTrades[0].count > 0) {
      // Show sample trades
      const sampleTrades = await db
        .select()
        .from(agentTrades)
        .orderBy(desc(agentTrades.executedAt))
        .limit(5);

      console.log('Sample trades:');
      sampleTrades.forEach((trade, idx) => {
        console.log(
          `${idx + 1}. Agent: ${trade.agentUserId} | Action: ${trade.action} | Ticker: ${trade.ticker} | Time: ${trade.executedAt}`
        );
      });
      console.log('');
    }

    // Check users with isAgent=true
    const agentUsers = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isAgent: users.isAgent,
        managedBy: users.managedBy,
        autonomousTrading: users.autonomousTrading,
        agentStatus: users.agentStatus,
        agentCount: users.agentCount,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.isAgent, true))
      .limit(20);

    console.log(`👤 Users with isAgent=true: ${agentUsers.length}\n`);

    if (agentUsers.length > 0) {
      console.log('Agent users:');
      agentUsers.forEach((user, idx) => {
        console.log(
          `${idx + 1}. ${user.username || user.displayName || user.id} | ` +
            `Status: ${user.agentStatus} | ` +
            `Autonomous Trading: ${user.autonomousTrading} | ` +
            `Created: ${user.createdAt.toISOString()}`
        );
      });
      console.log('');

      // Check if these agents have any trades (using IN clause instead of ANY)
      const agentIds = agentUsers.map((u) => u.id);
      const tradesForAgents = await db
        .select({
          agentUserId: agentTrades.agentUserId,
          count: sql<number>`count(*)::int`,
        })
        .from(agentTrades)
        .where(
          sql`${agentTrades.agentUserId} IN (${sql.join(
            agentIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        )
        .groupBy(agentTrades.agentUserId);

      console.log('Trades by agent users:');
      if (tradesForAgents.length === 0) {
        console.log('  None found\n');
      } else {
        tradesForAgents.forEach((stat) => {
          const agent = agentUsers.find((u) => u.id === stat.agentUserId);
          console.log(
            `  ${agent?.username || stat.agentUserId}: ${stat.count} trades`
          );
        });
        console.log('');
      }
    }

    // Check if there are users with autonomousTrading enabled
    const autonomousUsers = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isAgent: users.isAgent,
        autonomousTrading: users.autonomousTrading,
        agentStatus: users.agentStatus,
      })
      .from(users)
      .where(eq(users.autonomousTrading, true))
      .limit(20);

    console.log(
      `🤖 Users with autonomousTrading=true: ${autonomousUsers.length}\n`
    );

    if (autonomousUsers.length > 0) {
      console.log('Users with autonomous trading enabled:');
      autonomousUsers.forEach((user, idx) => {
        console.log(
          `${idx + 1}. ${user.username || user.displayName || user.id} | ` +
            `isAgent: ${user.isAgent} | ` +
            `Status: ${user.agentStatus}`
        );
      });
      console.log('');
    }

    // Check PerpPositions for any recent trading activity
    const recentPositions = await db
      .select({
        userId: perpPositions.userId,
        ticker: perpPositions.ticker,
        side: perpPositions.side,
        size: perpPositions.size,
        openedAt: perpPositions.openedAt,
        closedAt: perpPositions.closedAt,
      })
      .from(perpPositions)
      .orderBy(desc(perpPositions.openedAt))
      .limit(10);

    console.log(
      `📈 Recent perp positions (last 10): ${recentPositions.length}\n`
    );

    if (recentPositions.length > 0) {
      console.log('Recent positions:');
      recentPositions.forEach((pos, idx) => {
        const status = pos.closedAt ? 'CLOSED' : 'OPEN';
        const timeAgo = getTimeAgo(pos.openedAt);
        console.log(
          `${idx + 1}. User: ${pos.userId.slice(0, 8)}... | ` +
            `${pos.ticker} ${pos.side} | ` +
            `Size: ${pos.size} | ` +
            `Status: ${status} | ` +
            `Opened: ${timeAgo}`
        );
      });
      console.log('');

      // Check if these users are agents (using IN clause instead of ANY)
      const userIds = [...new Set(recentPositions.map((p) => p.userId))];
      const usersData = await db
        .select({
          id: users.id,
          username: users.username,
          isAgent: users.isAgent,
          autonomousTrading: users.autonomousTrading,
        })
        .from(users)
        .where(
          sql`${users.id} IN (${sql.join(
            userIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        );

      console.log('Are these users agents?');
      usersData.forEach((user) => {
        console.log(
          `  ${user.username || user.id.slice(0, 8)}: ` +
            `isAgent=${user.isAgent}, autonomousTrading=${user.autonomousTrading}`
        );
      });
      console.log('');
    }
  } catch (error) {
    console.error('Error debugging:', error);
    throw error;
  }
}

// Run the debug check
debugAgentData()
  .then(() => {
    console.log('✅ Debug complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Debug failed:', error);
    process.exit(1);
  });
