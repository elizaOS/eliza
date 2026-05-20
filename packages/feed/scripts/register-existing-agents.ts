#!/usr/bin/env bun

/**
 * Register existing user agents in AgentRegistry
 *
 * This script finds all User records with isAgent=true that are NOT
 * in AgentRegistry and registers them so they can be picked up by
 * the agent-tick cron job.
 */

import { agentRegistry } from '@feed/agents';
import { db } from '@feed/db';
import { agentRegistries, users } from '@feed/db/schema';
import { eq } from 'drizzle-orm';

async function registerExistingAgents() {
  console.log('🔍 Finding unregistered agent users...\n');

  try {
    // 1. Get all user IDs that are already registered
    const registeredAgents = await db
      .select({ userId: agentRegistries.userId })
      .from(agentRegistries)
      .where(eq(agentRegistries.type, 'USER_CONTROLLED'));

    const registeredUserIds = registeredAgents
      .map((r) => r.userId)
      .filter((id): id is string => id !== null);

    console.log(
      `Found ${registeredUserIds.length} already registered user agents\n`
    );

    // 2. Get all agent users from User table
    const allAgentUsers = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        agentSystem: users.agentSystem,
        agentPersonality: users.agentPersonality,
        agentTradingStrategy: users.agentTradingStrategy,
        autonomousTrading: users.autonomousTrading,
        autonomousPosting: users.autonomousPosting,
        autonomousCommenting: users.autonomousCommenting,
        autonomousDMs: users.autonomousDMs,
        autonomousGroupChats: users.autonomousGroupChats,
        agentPointsBalance: users.agentPointsBalance,
      })
      .from(users)
      .where(eq(users.isAgent, true));

    console.log(
      `Found ${allAgentUsers.length} total user agents in User table\n`
    );

    // 3. Filter to find unregistered agents
    const unregisteredAgents =
      registeredUserIds.length > 0
        ? allAgentUsers.filter((u) => !registeredUserIds.includes(u.id))
        : allAgentUsers;

    console.log(`Found ${unregisteredAgents.length} unregistered agents\n`);

    if (unregisteredAgents.length === 0) {
      console.log('✅ All agent users are already registered!');
      return;
    }

    // 4. Register each unregistered agent
    console.log('📝 Registering agents...\n');
    let successCount = 0;
    let errorCount = 0;
    const errors: Array<{ agent: string; error: string }> = [];

    for (const agent of unregisteredAgents) {
      const agentName = agent.displayName || agent.username || agent.id;

      try {
        // Determine default capabilities based on enabled features
        const strategies: string[] = [
          'prediction_markets',
          'social_interaction',
        ];
        if (agent.autonomousTrading) strategies.push('trading_autonomous');
        if (agent.autonomousPosting) strategies.push('content_generation');

        const actions: string[] = [];
        if (agent.autonomousTrading) actions.push('trade');
        if (agent.autonomousPosting) actions.push('post');
        if (agent.autonomousCommenting) actions.push('comment');
        if (agent.autonomousDMs) actions.push('message');
        if (agent.autonomousGroupChats) actions.push('group_chat');

        // Register the agent
        await agentRegistry.registerUserAgent({
          userId: agent.id,
          name: agentName,
          systemPrompt:
            agent.agentSystem ||
            `You are ${agentName}, an autonomous AI agent on Feed prediction market platform.`,
          capabilities: {
            strategies,
            markets: ['prediction', 'perpetual', 'spot'],
            actions: actions.length > 0 ? actions : ['analyze_market'],
            version: '1.0.0',
            x402Support: true,
            platform: 'feed',
            userType: 'user_controlled',
            skills: [],
            domains: [],
          },
        });

        successCount++;
        console.log(
          `✅ ${successCount}/${unregisteredAgents.length} - ` +
            `Registered: ${agentName} | ` +
            `Features: ${
              [
                agent.autonomousTrading && 'trading',
                agent.autonomousPosting && 'posting',
                agent.autonomousCommenting && 'commenting',
                agent.autonomousDMs && 'DMs',
                agent.autonomousGroupChats && 'group-chats',
              ]
                .filter(Boolean)
                .join(', ') || 'none'
            } | ` +
            `Points: ${agent.agentPointsBalance}`
        );
      } catch (error) {
        errorCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ agent: agentName, error: errorMsg });
        console.error(`❌ Failed to register ${agentName}:`, errorMsg);
      }
    }

    // 5. Summary
    console.log('\n' + '='.repeat(120));
    console.log('📊 Registration Summary:');
    console.log('='.repeat(120));
    console.log(`Total agents found: ${allAgentUsers.length}`);
    console.log(`Already registered: ${registeredUserIds.length}`);
    console.log(`Needed registration: ${unregisteredAgents.length}`);
    console.log(`Successfully registered: ${successCount}`);
    console.log(`Failed: ${errorCount}`);

    if (errors.length > 0) {
      console.log('\n❌ Errors:');
      errors.forEach(({ agent, error }) => {
        console.log(`  - ${agent}: ${error}`);
      });
    }

    if (successCount > 0) {
      console.log('\n✅ Registration complete!');
      console.log('\n💡 Next steps:');
      console.log(
        '   1. Verify agents are registered: bun run scripts/check-agent-status.ts'
      );
      console.log(
        '   2. Manually trigger agent tick: POST /api/cron/agent-tick'
      );
      console.log(
        '   3. Check for trades: bun run scripts/check-agent-trades.ts'
      );
    }
  } catch (error) {
    console.error('Error registering agents:', error);
    throw error;
  }
}

// Run the registration
registerExistingAgents()
  .then(() => {
    console.log('\n✅ Script complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
