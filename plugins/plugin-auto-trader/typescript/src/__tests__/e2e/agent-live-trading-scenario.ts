import type { IAgentRuntime, TestSuite, Content } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import { setupScenario, sendMessageAndWaitForResponse } from './test-utils.ts';
import axios from 'axios';

// Configuration for the live trading scenario
const SCENARIO_CONFIG = {
  // Trading parameters
  INITIAL_CAPITAL: 100, // $100 USDC for testing
  MAX_POSITION_SIZE: 10, // $10 max per trade
  STOP_LOSS_PERCENT: 5,
  TAKE_PROFIT_PERCENT: 10,

  // Timing
  SCENARIO_DURATION: 180000, // 3 minutes
  CHECK_INTERVAL: 15000, // Check every 15 seconds

  // Test tokens
  TOKENS: {
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
};

// Helper to verify transactions on Solscan
async function verifySolscanTransaction(txId: string, retries = 3): Promise<boolean> {
  const SOLSCAN_API = 'https://public-api.solscan.io/transaction';

  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));

      const response = await axios.get(`${SOLSCAN_API}/${txId}`, {
        headers: { accept: 'application/json' },
      });

      if (response.data && response.data.success) {
        return true;
      }
    } catch (error) {
      // Transaction might not be indexed yet
    }
  }
  return false;
}

export const agentLiveTradingScenario: TestSuite = {
  name: 'Agent Live Trading Scenario',
  tests: [
    {
      name: 'Complete Trading Conversation Flow',
      fn: async (runtime: IAgentRuntime) => {
        console.log('\n🤖 Starting Agent Live Trading Scenario');
        console.log('======================================\n');

        // Setup test environment
        const { user, room } = await setupScenario(runtime);

        // Track conversation and trading state
        const conversationLog: { user: string; agent: string; timestamp: Date }[] = [];
        const executedTrades: any[] = [];
        let tradingActive = false;

        // Helper to log conversation
        const logConversation = (userMsg: string, agentResponse: Content) => {
          conversationLog.push({
            user: userMsg,
            agent: agentResponse.text || '',
            timestamp: new Date(),
          });
          console.log(`\n👤 User: ${userMsg}`);
          console.log(`🤖 Agent: ${agentResponse.text}\n`);
        };

        // Step 1: Check portfolio status
        console.log('📊 Step 1: Checking portfolio status...');
        const portfolioResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "What's my current portfolio status?"
        );
        logConversation("What's my current portfolio status?", portfolioResponse);
        assert(portfolioResponse.text, 'Agent should respond about portfolio');

        // Step 2: Ask about market conditions
        console.log('📈 Step 2: Analyzing market conditions...');
        const marketResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Can you analyze the current market conditions for BONK and WIF?'
        );
        logConversation(
          'Can you analyze the current market conditions for BONK and WIF?',
          marketResponse
        );
        assert(marketResponse.text, 'Agent should provide market analysis');

        // Step 3: Configure trading strategy
        console.log('⚙️ Step 3: Configuring trading strategy...');
        const strategyResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Configure the RSI strategy with max position size of $${SCENARIO_CONFIG.MAX_POSITION_SIZE}, ${SCENARIO_CONFIG.STOP_LOSS_PERCENT}% stop loss, and ${SCENARIO_CONFIG.TAKE_PROFIT_PERCENT}% take profit`
        );
        logConversation(
          `Configure the RSI strategy with max position size of $${SCENARIO_CONFIG.MAX_POSITION_SIZE}, ${SCENARIO_CONFIG.STOP_LOSS_PERCENT}% stop loss, and ${SCENARIO_CONFIG.TAKE_PROFIT_PERCENT}% take profit`,
          strategyResponse
        );
        assert(strategyResponse.text?.includes('configured'), 'Strategy should be configured');

        // Step 4: Start live trading
        console.log('🚀 Step 4: Starting live trading...');
        const startResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Start live trading with BONK and WIF using the RSI strategy'
        );
        logConversation(
          'Start live trading with BONK and WIF using the RSI strategy',
          startResponse
        );
        assert(
          startResponse.text?.includes('started') || startResponse.text?.includes('trading'),
          'Trading should start'
        );
        tradingActive = true;

        // Get services for monitoring
        const autoTrading = runtime.getService('AutoTradingService') as any;
        const transactionMonitoring = runtime.getService('TransactionMonitoringService') as any;

        assert(autoTrading, 'AutoTradingService should be available');
        assert(transactionMonitoring, 'TransactionMonitoringService should be available');

        // Step 5: Monitor trading for the scenario duration
        console.log(
          `\n⏱️ Monitoring trading for ${SCENARIO_CONFIG.SCENARIO_DURATION / 1000} seconds...\n`
        );

        const startTime = Date.now();
        let lastCheckTime = startTime;
        let checkCount = 0;

        while (Date.now() - startTime < SCENARIO_CONFIG.SCENARIO_DURATION) {
          await new Promise((resolve) => setTimeout(resolve, SCENARIO_CONFIG.CHECK_INTERVAL));
          checkCount++;

          // Periodically ask for status updates
          if (checkCount % 2 === 0) {
            const statusResponse = await sendMessageAndWaitForResponse(
              runtime,
              room,
              user,
              "What's the current trading status and P&L?"
            );
            logConversation("What's the current trading status and P&L?", statusResponse);
          }

          // Check for new transactions
          const logs = transactionMonitoring.getTransactionLogs({
            status: 'success',
            type: 'swap',
            limit: 20,
          });

          for (const tx of logs) {
            if (!executedTrades.find((t) => t.signature === tx.signature)) {
              executedTrades.push(tx);
              console.log(`\n💹 New Trade Executed:`);
              console.log(`   Transaction: ${tx.signature}`);
              console.log(`   Type: ${tx.metadata?.direction || 'swap'}`);
              console.log(`   Amount: $${tx.metadata?.amount || 'N/A'}`);

              // Verify on Solscan
              const verified = await verifySolscanTransaction(tx.signature);
              if (verified) {
                console.log(`   ✅ Verified on Solscan: https://solscan.io/tx/${tx.signature}`);
              }

              // Ask agent about the trade
              const tradeResponse = await sendMessageAndWaitForResponse(
                runtime,
                room,
                user,
                `Tell me about the trade you just executed (${tx.signature.slice(0, 8)}...)`
              );
              logConversation(
                `Tell me about the trade you just executed (${tx.signature.slice(0, 8)}...)`,
                tradeResponse
              );
            }
          }

          // Display progress
          const elapsed = Date.now() - startTime;
          const remaining = SCENARIO_CONFIG.SCENARIO_DURATION - elapsed;
          console.log(`\n⏱️ Time remaining: ${Math.ceil(remaining / 1000)}s`);
          console.log(`📊 Trades executed: ${executedTrades.length}`);

          const positions = autoTrading.getPositions();
          const dailyPnL = autoTrading.getDailyPnL();
          console.log(`💼 Open positions: ${positions.length}`);
          console.log(`💰 Daily P&L: $${dailyPnL.toFixed(2)}`);
        }

        // Step 6: Stop trading
        console.log('\n🛑 Step 6: Stopping trading...');
        const stopResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Stop trading and give me a final report'
        );
        logConversation('Stop trading and give me a final report', stopResponse);
        tradingActive = false;

        // Step 7: Get performance analysis
        console.log('\n📊 Step 7: Analyzing performance...');
        const analysisResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Analyze my trading performance from this session'
        );
        logConversation('Analyze my trading performance from this session', analysisResponse);

        // Final Report
        console.log('\n' + '='.repeat(60));
        console.log('📊 AGENT LIVE TRADING SCENARIO RESULTS');
        console.log('='.repeat(60) + '\n');

        const finalMetrics = transactionMonitoring.getTransactionMetrics();
        const finalPnL = autoTrading.getTotalPnL();

        console.log('Conversation Summary:');
        console.log(`- Total interactions: ${conversationLog.length}`);
        console.log(`- Scenario duration: ${SCENARIO_CONFIG.SCENARIO_DURATION / 1000} seconds`);

        console.log('\nTrading Summary:');
        console.log(`- Executed trades: ${executedTrades.length}`);
        console.log(`- Total P&L: $${finalPnL.toFixed(2)}`);
        console.log(
          `- Success rate: ${
            finalMetrics.totalTransactions > 0
              ? (
                  (finalMetrics.successfulTransactions / finalMetrics.totalTransactions) *
                  100
                ).toFixed(1)
              : 0
          }%`
        );
        console.log(`- Total fees: ${finalMetrics.totalFees.toFixed(4)} SOL`);

        // Save conversation log
        const fs = await import('fs/promises');
        const scenarioResults = {
          testName: 'Agent Live Trading Scenario',
          duration: SCENARIO_CONFIG.SCENARIO_DURATION,
          conversationLog,
          executedTrades: executedTrades.map((t) => ({
            signature: t.signature,
            timestamp: t.timestamp,
            metadata: t.metadata,
          })),
          metrics: finalMetrics,
          finalPnL,
          timestamp: new Date().toISOString(),
        };

        await fs.writeFile(
          'agent_live_trading_scenario_results.json',
          JSON.stringify(scenarioResults, null, 2)
        );
        console.log('\n📝 Scenario results saved to: agent_live_trading_scenario_results.json');

        // Assertions
        assert(conversationLog.length >= 6, 'Should have at least 6 conversation exchanges');
        assert(executedTrades.length > 0, 'Should execute at least one trade during the scenario');

        console.log('\n✅ SCENARIO COMPLETED SUCCESSFULLY!');
      },
    },

    {
      name: 'Risk Management Scenario',
      fn: async (runtime: IAgentRuntime) => {
        console.log('\n🛡️ Starting Risk Management Scenario');
        console.log('====================================\n');

        const { user, room } = await setupScenario(runtime);

        // Configure aggressive trading to trigger risk limits
        console.log('⚠️ Configuring aggressive trading parameters...');
        const configResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Configure random strategy with $50 max position size and 2% stop loss'
        );
        console.log(`🤖 Agent: ${configResponse.text}\n`);

        // Start trading
        const startResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Start trading BONK with a $5 daily loss limit'
        );
        console.log(`🤖 Agent: ${startResponse.text}\n`);

        // Get services
        const autoTrading = runtime.getService('AutoTradingService') as any;
        const riskManagement = runtime.getService('RiskManagementService') as any;

        // Monitor for risk events
        console.log('📊 Monitoring for risk management events...\n');

        let riskEventTriggered = false;
        const checkRisk = setInterval(async () => {
          const riskMetrics = riskManagement.getRiskMetrics();

          if (riskMetrics.dailyLoss >= 5) {
            riskEventTriggered = true;
            clearInterval(checkRisk);

            console.log('⚠️ Daily loss limit reached!');

            // Ask agent about the situation
            const riskResponse = await sendMessageAndWaitForResponse(
              runtime,
              room,
              user,
              'Why did trading stop? What happened?'
            );
            console.log(`🤖 Agent: ${riskResponse.text}\n`);

            assert(
              riskResponse.text?.includes('loss limit') || riskResponse.text?.includes('risk'),
              'Agent should explain risk management trigger'
            );
          }
        }, 5000);

        // Wait up to 60 seconds for risk event
        await new Promise((resolve) => setTimeout(resolve, 60000));
        clearInterval(checkRisk);

        // Stop trading
        await sendMessageAndWaitForResponse(runtime, room, user, 'Stop all trading');

        if (riskEventTriggered) {
          console.log('✅ Risk management scenario completed - loss limit triggered');
        } else {
          console.log('✅ Risk management scenario completed - no risk events triggered');
        }
      },
    },
  ],
};

export default agentLiveTradingScenario;
