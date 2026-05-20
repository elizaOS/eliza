#!/usr/bin/env bun

/**
 * Check agent status and game state
 * Diagnose why agents aren't trading
 */

import { db } from '@feed/db';
import { agentRegistries, games, users } from '@feed/db/schema';
import { getTimeAgo } from '@feed/shared';
import { desc, eq, inArray } from 'drizzle-orm';

async function checkAgentStatus() {
  console.log('🔍 Checking agent status and game state...\n');

  try {
    // 1. Check GAME_START env var
    console.log('1️⃣  Environment Check:');
    console.log('='.repeat(120));
    console.log(
      `GAME_START: ${process.env.GAME_START || 'not set (defaults to true)'}`
    );
    console.log('');

    // 2. Check game state
    console.log('2️⃣  Game State:');
    console.log('='.repeat(120));

    const gameStates = await db
      .select({
        id: games.id,
        currentDay: games.currentDay,
        isContinuous: games.isContinuous,
        isRunning: games.isRunning,
        lastTickAt: games.lastTickAt,
        createdAt: games.createdAt,
      })
      .from(games)
      .orderBy(desc(games.createdAt))
      .limit(5);

    if (gameStates.length === 0) {
      console.log('❌ No games found in database!');
    } else {
      gameStates.forEach((game, idx) => {
        const lastTick = game.lastTickAt
          ? getTimeAgo(game.lastTickAt)
          : 'never';
        console.log(
          `${idx + 1}. Game ${game.id} (Day ${game.currentDay}) | ` +
            `isContinuous: ${game.isContinuous} | ` +
            `isRunning: ${game.isRunning} | ` +
            `Last tick: ${lastTick}`
        );
      });

      const continuousGame = gameStates.find((g) => g.isContinuous);
      if (continuousGame) {
        console.log(`\n✅ Continuous game found: ${continuousGame.id}`);
        if (continuousGame.isRunning) {
          console.log('✅ Game is RUNNING');
        } else {
          console.log('❌ Game is NOT RUNNING (isRunning=false)');
        }
      } else {
        console.log(
          '\n❌ No continuous game found (isContinuous=true required)'
        );
      }
    }
    console.log('');

    // 3. Check agent registry
    console.log('3️⃣  Agent Registry:');
    console.log('='.repeat(120));

    const registeredAgents = await db
      .select({
        agentId: agentRegistries.agentId,
        name: agentRegistries.name,
        type: agentRegistries.type,
        status: agentRegistries.status,
        userId: agentRegistries.userId,
        registeredAt: agentRegistries.registeredAt,
        lastActiveAt: agentRegistries.lastActiveAt,
      })
      .from(agentRegistries)
      .orderBy(desc(agentRegistries.registeredAt))
      .limit(30);

    console.log(`Total registered agents: ${registeredAgents.length}`);

    if (registeredAgents.length > 0) {
      console.log('\nRegistered agents:');
      registeredAgents.slice(0, 15).forEach((agent, idx) => {
        const lastActive = agent.lastActiveAt
          ? getTimeAgo(agent.lastActiveAt)
          : 'never';
        console.log(
          `${idx + 1}. ${agent.name} | ` +
            `Type: ${agent.type} | ` +
            `Status: ${agent.status} | ` +
            `Last active: ${lastActive}`
        );
      });

      // Count by status
      const statusCounts = registeredAgents.reduce(
        (acc, agent) => {
          acc[agent.status] = (acc[agent.status] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      console.log('\nAgent Status Distribution:');
      Object.entries(statusCounts).forEach(([status, count]) => {
        console.log(`  ${status}: ${count}`);
      });

      // Check which ones are eligible for cron (ACTIVE, INITIALIZED, REGISTERED)
      const eligibleStatuses = ['ACTIVE', 'INITIALIZED', 'REGISTERED'];
      const eligible = registeredAgents.filter((a) =>
        eligibleStatuses.includes(a.status)
      );
      console.log(
        `\n✅ Eligible for cron (ACTIVE/INITIALIZED/REGISTERED): ${eligible.length}`
      );
    } else {
      console.log('❌ No agents registered in AgentRegistry table!');
    }
    console.log('');

    // 4. Check User table agents
    console.log('4️⃣  User Table Agents:');
    console.log('='.repeat(120));

    const userAgents = await db
      .select({
        id: users.id,
        username: users.username,
        isAgent: users.isAgent,
        autonomousTrading: users.autonomousTrading,
        agentStatus: users.agentStatus,
        agentPointsBalance: users.agentPointsBalance,
        agentLastTickAt: users.agentLastTickAt,
      })
      .from(users)
      .where(eq(users.isAgent, true))
      .limit(20);

    console.log(`Users with isAgent=true: ${userAgents.length}`);

    if (userAgents.length > 0) {
      console.log('\nAgent users with autonomous trading enabled:');
      const tradingAgents = userAgents.filter((u) => u.autonomousTrading);
      console.log(`  ${tradingAgents.length} have autonomousTrading=true`);

      tradingAgents.slice(0, 10).forEach((user, idx) => {
        const lastTick = user.agentLastTickAt
          ? getTimeAgo(user.agentLastTickAt)
          : 'never';
        console.log(
          `  ${idx + 1}. ${user.username} | ` +
            `Points: ${user.agentPointsBalance} | ` +
            `Status: ${user.agentStatus} | ` +
            `Last tick: ${lastTick}`
        );
      });

      // Check if these users are in AgentRegistry
      const userIds = userAgents.map((u) => u.id);
      const registeredForUsers = await db
        .select({
          userId: agentRegistries.userId,
          agentId: agentRegistries.agentId,
          name: agentRegistries.name,
          status: agentRegistries.status,
        })
        .from(agentRegistries)
        .where(inArray(agentRegistries.userId, userIds));

      console.log(
        `\n🔗 Linked to AgentRegistry: ${registeredForUsers.length}/${userAgents.length}`
      );

      if (registeredForUsers.length < userAgents.length) {
        console.log('⚠️  Some user agents are NOT in AgentRegistry table!');
        const missingUserIds = userIds.filter(
          (id) => !registeredForUsers.find((r) => r.userId === id)
        );
        console.log(`   Missing: ${missingUserIds.length} agents`);
      }
    }
    console.log('');

    // 5. Summary and diagnosis
    console.log('5️⃣  Diagnosis Summary:');
    console.log('='.repeat(120));

    const issues: string[] = [];
    const checks: string[] = [];

    // Check game state
    const continuousGame = gameStates.find((g) => g.isContinuous);
    if (!continuousGame) {
      issues.push('❌ No continuous game found (need isContinuous=true)');
    } else if (!continuousGame.isRunning) {
      issues.push('❌ Game exists but not running (need isRunning=true)');
    } else {
      checks.push('✅ Continuous game is running');
    }

    // Check GAME_START env
    const gameStartEnv = process.env.GAME_START?.toLowerCase();
    if (gameStartEnv === 'false' || gameStartEnv === '0') {
      issues.push('❌ GAME_START environment variable is disabled');
    } else {
      checks.push('✅ GAME_START not disabled');
    }

    // Check agent registry
    const eligibleStatuses = ['ACTIVE', 'INITIALIZED', 'REGISTERED'];
    const eligibleAgents = registeredAgents.filter((a) =>
      eligibleStatuses.includes(a.status)
    );
    if (eligibleAgents.length === 0) {
      issues.push(
        '❌ No agents with eligible status (ACTIVE/INITIALIZED/REGISTERED)'
      );
    } else {
      checks.push(`✅ ${eligibleAgents.length} agents eligible in registry`);
    }

    // Check if user agents have points
    const agentsWithPoints = userAgents.filter(
      (u) => u.agentPointsBalance >= 1
    );
    if (agentsWithPoints.length === 0 && userAgents.length > 0) {
      issues.push('⚠️  No agents have sufficient points (need >= 1)');
    } else if (agentsWithPoints.length > 0) {
      checks.push(
        `✅ ${agentsWithPoints.length} agents have sufficient points`
      );
    }

    console.log('Passing checks:');
    checks.forEach((check) => console.log(check));
    console.log('');

    if (issues.length > 0) {
      console.log('🚨 Issues found:');
      issues.forEach((issue) => console.log(issue));
      console.log('');
      console.log('💡 Agents will NOT trade until these issues are resolved.');
    } else {
      console.log(
        '✅ All checks passed! Agents should be trading if cron is running.'
      );
      console.log('');
      console.log('💡 Next steps:');
      console.log(
        '   1. Check if /api/cron/agent-tick is being called regularly'
      );
      console.log('   2. Check agent-tick logs for errors');
      console.log('   3. Manually trigger: POST /api/cron/agent-tick');
    }
  } catch (error) {
    console.error('Error checking status:', error);
    throw error;
  }
}

// Run the check
checkAgentStatus()
  .then(() => {
    console.log('\n✅ Check complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Check failed:', error);
    process.exit(1);
  });
