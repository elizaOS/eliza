import { strict as assert } from "node:assert";
import type { IAgentRuntime, TestSuite } from "@elizaos/core";
import { sendMessageAndWaitForResponse, setupScenario } from "./test-utils.ts";

// Mock services are registered in setupScenario; this stub is called for backward compatibility.
async function setupMockLpData(_runtime: IAgentRuntime) {}

/**
 * Defines a suite of E2E tests for LP Manager plugin real-world Discord/Telegram scenarios.
 *
 * These scenarios simulate authentic user interactions with the LP management agent,
 * covering the complete user journey from onboarding to advanced yield optimization.
 */
export const lpManagerScenariosSuite: TestSuite = {
  name: "LP Manager Plugin Real-World Scenarios",
  tests: [
    {
      name: "Scenario 1: New User Onboarding - First Time LP Experience",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // Simulate natural Discord message from crypto newcomer
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Hey! I keep hearing about providing liquidity to earn yield. Can you help me get started? I have some SOL and USDC sitting around doing nothing.",
        );

        console.log("Agent Response for New User Onboarding:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should explain LP management and mention onboarding
        assert.match(
          response.text,
          /liquidity|yield|onboard|vault|start|LP|provide/i,
          `Expected response to acknowledge LP onboarding context, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 2: User Vault Creation and Setup",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User decides to proceed with onboarding
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Yes, I want to start LP management. Set me up with a vault please!",
        );

        console.log("Agent Response for Vault Creation:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should mention vault creation, public key, and auto-rebalance settings
        assert.match(
          response.text,
          /vault|public key|onboard|auto.*rebalance|enabled|disabled/i,
          `Expected response to acknowledge vault creation, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 3: Simple LP Deposit - 'LP all my SOL and USDC'",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants to deposit all their tokens
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I want to LP all my SOL and USDC. Find me the best pool with good APR!",
        );

        console.log("Agent Response for LP All Tokens:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should reference pools, APR, and LP deposit process
        assert.match(
          response.text,
          /pool|APR|deposit|liquidity|SOL|USDC|yield|best/i,
          `Expected response to acknowledge LP deposit request, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 4: Specific Amount LP Deposit - 'LP 10 USDC'",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants to deposit specific amount
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Just LP 10 USDC for now. What SOL amount do I need to pair with it?",
        );

        console.log("Agent Response for Specific Amount LP:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should calculate pairing amounts and explain ratio
        assert.match(
          response.text,
          /10|USDC|SOL|pair|ratio|pool|amount|deposit/i,
          `Expected response to acknowledge specific amount LP request, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 5: Percentage-Based LP Deposit - 'LP 50% of my holdings'",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants percentage-based deposit
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I want to LP 50% of my SOL bag. Keep the rest for emergencies.",
        );

        console.log("Agent Response for Percentage LP:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should calculate percentage and mention pool selection
        assert.match(
          response.text,
          /50%|SOL|percentage|deposit|pool|liquidity|amount/i,
          `Expected response to acknowledge percentage LP request, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 6: Check LP Positions - 'Show me my LP positions'",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants to see their current positions
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Show me all my LP positions. How am I doing? What's my current yield?",
        );

        console.log("Agent Response for LP Position Check:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should display positions with details
        assert.match(
          response.text,
          /position|LP|value|yield|underlying|SOL|USDC|pool/i,
          `Expected response to show LP positions, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 7: Yield Optimization Discovery - Auto-rebalance Alert",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // Agent proactively suggests rebalancing
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I heard there are higher yield opportunities. Can you check if I should move my LP to a better pool?",
        );

        console.log("Agent Response for Yield Optimization:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should mention yield comparison and rebalancing opportunities
        assert.match(
          response.text,
          /yield|APR|opportunity|rebalance|pool|higher|optimize|move/i,
          `Expected response to acknowledge yield optimization request, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 8: Auto-Rebalance Configuration - Risk Preferences",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants to configure auto-rebalancing
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I want to enable auto-rebalancing but only if the gain is at least 5%. Also, keep slippage under 1%. Can you set that up?",
        );

        console.log("Agent Response for Auto-Rebalance Setup:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should acknowledge configuration settings
        assert.match(
          response.text,
          /auto.*rebalance|5%|gain|slippage|1%|enable|configure|preference/i,
          `Expected response to acknowledge auto-rebalance configuration, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 9: Partial LP Withdrawal - 'Take profits'",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants to take partial profits
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "SOL is pumping! I want to withdraw 30% of my LP position to take some profits.",
        );

        console.log("Agent Response for Partial Withdrawal:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should handle percentage withdrawal
        assert.match(
          response.text,
          /withdraw|30%|profit|LP|position|SOL|partial|remove/i,
          `Expected response to acknowledge partial withdrawal request, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 10: Emergency Full Withdrawal - 'Exit all positions'",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User needs emergency withdrawal
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Market is crashing! I need to exit all my LP positions immediately and get back to stablecoins.",
        );

        console.log("Agent Response for Emergency Withdrawal:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should handle emergency exit scenario
        assert.match(
          response.text,
          /exit|withdraw|all|position|emergency|market|crash|stable/i,
          `Expected response to acknowledge emergency withdrawal, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 11: Advanced Strategy - Stablecoin Focus",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants conservative strategy
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I'm risk-averse. Only show me stable pools like USDC/USDT. I want steady yield without impermanent loss risk.",
        );

        console.log("Agent Response for Stablecoin Strategy:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should focus on stable pairs and low risk
        assert.match(
          response.text,
          /stable|USDC|USDT|risk|impermanent.*loss|steady|yield|conservative/i,
          `Expected response to acknowledge stablecoin strategy, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 12: Pool Comparison and Analysis",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants detailed pool analysis
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Compare all the SOL/USDC pools for me. Show APRs, TVL, fees, and which DEX is best right now.",
        );

        console.log("Agent Response for Pool Comparison:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should provide detailed comparison
        assert.match(
          response.text,
          /compare|SOL.*USDC|APR|TVL|fee|DEX|pool|best|analysis/i,
          `Expected response to provide pool comparison, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 13: Transaction Cost Analysis - 'Is it worth rebalancing?'",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants cost-benefit analysis
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I see a pool with 2% higher APR. Is it worth paying the gas fees to move my position? Calculate the break-even point.",
        );

        console.log("Agent Response for Cost Analysis:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should analyze costs vs benefits
        assert.match(
          response.text,
          /2%|higher|APR|gas|fee|cost|break.*even|worth|calculate|rebalance/i,
          `Expected response to analyze rebalancing costs, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 14: Portfolio Diversification Strategy",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants diversified approach
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I don't want all my eggs in one basket. Split my liquidity across multiple pools - some stable, some growth. What do you recommend?",
        );

        console.log("Agent Response for Diversification:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should suggest diversification strategy
        assert.match(
          response.text,
          /diversify|split|multiple|pool|stable|growth|recommend|basket|strategy/i,
          `Expected response to suggest diversification, but got: "${response.text}"`,
        );
      },
    },

    {
      name: "Scenario 15: Performance Tracking and Analytics",
      fn: async (runtime: IAgentRuntime) => {
        await setupMockLpData(runtime);
        const { user, room } = await setupScenario(runtime);

        // User wants performance insights
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "How has my LP performance been this month? Show me total yield earned, impermanent loss, and compare to just HODLing.",
        );

        console.log("Agent Response for Performance Analytics:", response.text);

        assert(
          typeof response.text === "string" && response.text.length > 0,
          "Agent response should have a non-empty text property.",
        );

        // Should provide performance analysis
        assert.match(
          response.text,
          /performance|month|yield|earned|impermanent.*loss|HODL|compare|analytics/i,
          `Expected response to provide performance analytics, but got: "${response.text}"`,
        );
      },
    },
  ],
};

export default lpManagerScenariosSuite;
