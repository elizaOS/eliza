#!/usr/bin/env bun

/**
 * Check recent agent trading activity
 * Uses safe parameterized queries via Drizzle ORM
 */

import { db } from '@feed/db';
import { agentTrades, users } from '@feed/db/schema';
import { getTimeAgo } from '@feed/shared';
import { desc, eq, sql } from 'drizzle-orm';

async function checkAgentTrades() {
  console.log('🔍 Checking recent agent trading activity...\n');

  try {
    // Get recent trades (last 50)
    const recentTrades = await db
      .select({
        id: agentTrades.id,
        agentUserId: agentTrades.agentUserId,
        username: users.username,
        displayName: users.displayName,
        marketType: agentTrades.marketType,
        ticker: agentTrades.ticker,
        action: agentTrades.action,
        side: agentTrades.side,
        amount: agentTrades.amount,
        price: agentTrades.price,
        pnl: agentTrades.pnl,
        reasoning: agentTrades.reasoning,
        executedAt: agentTrades.executedAt,
      })
      .from(agentTrades)
      .leftJoin(users, eq(agentTrades.agentUserId, users.id))
      .where(eq(users.isAgent, true))
      .orderBy(desc(agentTrades.executedAt))
      .limit(50);

    console.log(`📊 Found ${recentTrades.length} recent trades\n`);

    if (recentTrades.length === 0) {
      console.log(
        '❌ No agent trades found! Agents may not be actively trading.\n'
      );
      return;
    }

    // Display recent trades
    console.log('Recent Trades:');
    console.log('='.repeat(120));
    recentTrades.slice(0, 10).forEach((trade, idx) => {
      const agentName =
        trade.username || trade.displayName || trade.agentUserId;
      const timeAgo = getTimeAgo(trade.executedAt);

      console.log(
        `${idx + 1}. ${agentName} | ${trade.action} ${trade.side || ''} | ` +
          `${trade.ticker || trade.marketType} | $${trade.amount} @ $${trade.price} | ` +
          `PnL: ${trade.pnl ? `$${trade.pnl}` : 'N/A'} | ${timeAgo}`
      );
      if (trade.reasoning) {
        console.log(
          `   💭 ${trade.reasoning.slice(0, 100)}${trade.reasoning.length > 100 ? '...' : ''}`
        );
      }
      console.log('');
    });

    // Get trading statistics
    const stats = await db
      .select({
        totalTrades: sql<number>`count(*)::int`,
        uniqueAgents: sql<number>`count(distinct ${agentTrades.agentUserId})::int`,
        tradesLast24h: sql<number>`count(*) filter (where ${agentTrades.executedAt} > now() - interval '24 hours')::int`,
        tradesLastHour: sql<number>`count(*) filter (where ${agentTrades.executedAt} > now() - interval '1 hour')::int`,
        avgTradeAmount: sql<number>`avg(${agentTrades.amount})`,
        totalVolume: sql<number>`sum(${agentTrades.amount})`,
      })
      .from(agentTrades)
      .leftJoin(users, eq(agentTrades.agentUserId, users.id))
      .where(eq(users.isAgent, true));

    const stat = stats[0];
    console.log('\n📈 Trading Statistics:');
    console.log('='.repeat(120));
    console.log(`Total Trades: ${stat.totalTrades}`);
    console.log(`Unique Agents Trading: ${stat.uniqueAgents}`);
    console.log(`Trades in Last 24 Hours: ${stat.tradesLast24h}`);
    console.log(`Trades in Last Hour: ${stat.tradesLastHour}`);
    console.log(
      `Average Trade Amount: $${stat.avgTradeAmount?.toFixed(2) || 0}`
    );
    console.log(`Total Trading Volume: $${stat.totalVolume?.toFixed(2) || 0}`);

    // Get most active agents
    const activeAgents = await db
      .select({
        agentUserId: agentTrades.agentUserId,
        username: users.username,
        displayName: users.displayName,
        tradeCount: sql<number>`count(*)::int`,
        lastTradeAt: sql<Date>`max(${agentTrades.executedAt})`,
        totalVolume: sql<number>`sum(${agentTrades.amount})`,
      })
      .from(agentTrades)
      .leftJoin(users, eq(agentTrades.agentUserId, users.id))
      .where(eq(users.isAgent, true))
      .groupBy(agentTrades.agentUserId, users.username, users.displayName)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    console.log('\n🏆 Most Active Agents:');
    console.log('='.repeat(120));
    activeAgents.forEach((agent, idx) => {
      const agentName =
        agent.username || agent.displayName || agent.agentUserId;
      const lastTradeAgo = getTimeAgo(agent.lastTradeAt);
      console.log(
        `${idx + 1}. ${agentName} | ${agent.tradeCount} trades | ` +
          `$${agent.totalVolume?.toFixed(2) || 0} volume | Last trade: ${lastTradeAgo}`
      );
    });

    // Check if trading is happening recently
    console.log('\n🔔 Activity Check:');
    console.log('='.repeat(120));
    if (stat.tradesLastHour > 0) {
      console.log(`✅ ACTIVE: ${stat.tradesLastHour} trades in the last hour`);
    } else if (stat.tradesLast24h > 0) {
      console.log(
        `⚠️  SLOW: ${stat.tradesLast24h} trades in last 24h, but none in last hour`
      );
    } else {
      console.log(`❌ INACTIVE: No trades in the last 24 hours`);
    }

    // Get time of most recent trade
    if (recentTrades.length > 0) {
      const mostRecent = recentTrades[0];
      console.log(`\nMost recent trade: ${getTimeAgo(mostRecent.executedAt)}`);
      console.log(
        `Agent: ${mostRecent.username || mostRecent.displayName || mostRecent.agentUserId}`
      );
      console.log(
        `Action: ${mostRecent.action} ${mostRecent.side || ''} ${mostRecent.ticker || mostRecent.marketType}`
      );
    }
  } catch (error) {
    console.error('Error checking agent trades:', error);
    throw error;
  }
}

// Run the check
checkAgentTrades()
  .then(() => {
    console.log('\n✅ Check complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Check failed:', error);
    process.exit(1);
  });
