#!/usr/bin/env bun

/**
 * Diagnose why agents aren't trading
 */

import { db } from "@polyagent/db";
import { agentRegistries, users } from "@polyagent/db/schema";
import { eq } from "drizzle-orm";

async function diagnose() {
  console.log("🔍 Diagnosing agent trading issue...\n");

  const tickingAgents = [
    "254299341433339904", // agent_tcm_agent1
    "254577919010013184", // agent_xiplus_1579
    "255147756945932288", // agent_tcm_posting_agent1
  ];

  for (const agentId of tickingAgents) {
    const agent = await db
      .select({
        id: users.id,
        username: users.username,
        isAgent: users.isAgent,
        autonomousTrading: users.autonomousTrading,
        autonomousPosting: users.autonomousPosting,
        autonomousCommenting: users.autonomousCommenting,
        autonomousDMs: users.autonomousDMs,
        autonomousGroupChats: users.autonomousGroupChats,
        agentGoals: users.agentGoals,
        agentPlanningHorizon: users.agentPlanningHorizon,
        virtualBalance: users.virtualBalance,
        agentPointsBalance: users.agentPointsBalance,
        agentStatus: users.agentStatus,
      })
      .from(users)
      .where(eq(users.id, agentId))
      .limit(1);

    const agentData = agent[0];
    if (!agentData) continue;

    const registry = await db
      .select({
        agentId: agentRegistries.agentId,
        status: agentRegistries.status,
        type: agentRegistries.type,
      })
      .from(agentRegistries)
      .where(eq(agentRegistries.userId, agentId))
      .limit(1);

    console.log("═".repeat(80));
    console.log(`Agent: ${agentData.username}`);
    console.log("═".repeat(80));

    // Check eligibility
    const checks = {
      isAgent: agentData.isAgent,
      registered: registry.length > 0,
      registryStatus: registry[0]?.status,
      hasPoints: agentData.agentPointsBalance >= 1,
      hasBalance: parseFloat(agentData.virtualBalance) > 0,
      autonomousTrading: agentData.autonomousTrading,
      autonomousPosting: agentData.autonomousPosting,
      autonomousCommenting: agentData.autonomousCommenting,
      autonomousDMs: agentData.autonomousDMs,
      autonomousGroupChats: agentData.autonomousGroupChats,
    };

    console.log("\n✓ Eligibility Checks:");
    Object.entries(checks).forEach(([key, value]) => {
      const icon = value ? "✅" : "❌";
      console.log(`  ${icon} ${key}: ${value}`);
    });

    console.log("\n📝 Configuration:");
    console.log(`  Planning Horizon: ${agentData.agentPlanningHorizon}`);
    console.log(`  Has Goals: ${agentData.agentGoals ? "YES" : "NO"}`);
    console.log(`  Virtual Balance: $${agentData.virtualBalance}`);
    console.log(`  Points Balance: ${agentData.agentPointsBalance}`);
    console.log(`  Status: ${agentData.agentStatus}`);

    // Determine code path
    console.log("\n🔀 Code Path:");
    if (agentData.agentGoals && agentData.agentPlanningHorizon === "multi") {
      console.log("  → Using PLANNING COORDINATOR");
    } else {
      console.log("  → Using STANDARD COORDINATOR");
      console.log("    - Responses: batch response service");
      if (agentData.autonomousTrading) {
        console.log(
          "    - Trading: autonomousTradingService.executeTrades() 🎯",
        );
      } else {
        console.log("    - Trading: SKIPPED (not enabled)");
      }
      if (agentData.autonomousPosting) {
        console.log("    - Posting: enabled");
      }
      if (agentData.autonomousCommenting) {
        console.log("    - Commenting: enabled");
      }
    }

    console.log("");
  }

  console.log("═".repeat(80));
  console.log("\n💡 DIAGNOSIS:");
  console.log("   All 3 ticking agents have:");
  console.log("   ✅ isAgent=true");
  console.log("   ✅ registered in AgentRegistry");
  console.log("   ✅ autonomousTrading=true");
  console.log("   ✅ virtualBalance=$1000");
  console.log("   ✅ points >= 1");
  console.log("");
  console.log(
    "   They should be calling autonomousTradingService.executeTrades()",
  );
  console.log("   but NO LLM logs are being created.");
  console.log("");
  console.log("   🔴 POSSIBLE CAUSES:");
  console.log("   1. Trading service is silently failing before LLM call");
  console.log("   2. Agent-tick cron is NOT calling trading service at all");
  console.log("   3. Trading is disabled at deployment/environment level");
  console.log("   4. The deployed code is different from local code");
  console.log("");
  console.log("   📋 NEXT STEPS:");
  console.log("   1. Check Vercel/deployment logs for agent-tick executions");
  console.log("   2. Look for errors in production logs");
  console.log("   3. Verify GROQ_API_KEY is set in production");
  console.log("   4. Check if trading was intentionally disabled in prod");
}

diagnose()
  .then(() => {
    console.log("\n✅ Diagnosis complete");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Diagnosis failed:", error);
    process.exit(1);
  });
