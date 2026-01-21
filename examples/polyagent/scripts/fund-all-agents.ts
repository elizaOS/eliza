#!/usr/bin/env bun

/**
 * Give all agents starting virtual balance for trading
 */

import { db } from "@polyagent/db";
import { users } from "@polyagent/db/schema";
import { eq } from "drizzle-orm";

const STARTING_BALANCE = "1000.00"; // $1000 starting balance

async function fundAllAgents() {
  console.log(
    `💰 Funding all agents with $${STARTING_BALANCE} starting balance...\n`,
  );

  try {
    // 1. Get all agents
    const allAgents = await db
      .select({
        id: users.id,
        username: users.username,
        virtualBalance: users.virtualBalance,
        autonomousTrading: users.autonomousTrading,
      })
      .from(users)
      .where(eq(users.isAgent, true));

    console.log(`Found ${allAgents.length} total agents\n`);

    // 2. Find agents with low balance
    const agentsToFund = allAgents.filter(
      (a) => parseFloat(a.virtualBalance) < parseFloat(STARTING_BALANCE),
    );

    console.log(
      `Agents with sufficient balance (>=$${STARTING_BALANCE}): ${allAgents.length - agentsToFund.length}`,
    );
    console.log(`Agents to fund: ${agentsToFund.length}\n`);

    if (agentsToFund.length === 0) {
      console.log(`✅ All agents already have >=$${STARTING_BALANCE} balance!`);
      return;
    }

    // 3. Show agents that will be funded
    console.log("Funding agents:");
    agentsToFund.forEach((agent, idx) => {
      const currentBalance = parseFloat(agent.virtualBalance).toFixed(2);
      const trading = agent.autonomousTrading ? "✅" : "❌";
      console.log(
        `  ${idx + 1}. ${agent.username} | ` +
          `Current: $${currentBalance} → $${STARTING_BALANCE} | ` +
          `Trading: ${trading}`,
      );
    });
    console.log("");

    // 4. Fund all agents
    let successCount = 0;
    let errorCount = 0;
    const errors: Array<{ agent: string; error: string }> = [];

    for (const agent of agentsToFund) {
      try {
        await db
          .update(users)
          .set({
            virtualBalance: STARTING_BALANCE,
            totalDeposited: STARTING_BALANCE, // Track initial deposit
            updatedAt: new Date(),
          })
          .where(eq(users.id, agent.id));

        successCount++;
        console.log(
          `✅ ${successCount}/${agentsToFund.length} - Funded: ${agent.username}`,
        );
      } catch (error) {
        errorCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ agent: agent.username || agent.id, error: errorMsg });
        console.error(`❌ Failed for ${agent.username}:`, errorMsg);
      }
    }

    // 5. Summary
    console.log(`\n${"=".repeat(80)}`);
    console.log("📊 Funding Summary:");
    console.log("=".repeat(80));
    console.log(`Total agents: ${allAgents.length}`);
    console.log(`Already funded: ${allAgents.length - agentsToFund.length}`);
    console.log(`Needed funding: ${agentsToFund.length}`);
    console.log(`Successfully funded: ${successCount}`);
    console.log(`Failed: ${errorCount}`);
    console.log(
      `Total funds distributed: $${(successCount * parseFloat(STARTING_BALANCE)).toFixed(2)}`,
    );

    if (errors.length > 0) {
      console.log("\n❌ Errors:");
      errors.forEach(({ agent, error }) => {
        console.log(`  - ${agent}: ${error}`);
      });
    }

    if (successCount > 0) {
      console.log("\n✅ All agents funded and ready to trade!");
      console.log("\n💡 Next steps:");
      console.log("   1. Wait for next agent-tick cron cycle (~1-2 minutes)");
      console.log("   2. Check trades: bun run scripts/check-agent-trades.ts");
      console.log(
        "   3. Monitor tick logs: bun run scripts/check-last-tick.ts",
      );
    }
  } catch (error) {
    console.error("Error funding agents:", error);
    throw error;
  }
}

// Run the script
fundAllAgents()
  .then(() => {
    console.log("\n✅ Script complete");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
  });
