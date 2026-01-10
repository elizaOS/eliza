/**
 * N8n Plugin Action Tests
 * Tests for specific actions, workflow generation, and evaluator integration
 */

import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import {
  setupScenario,
  sendMessageAndWaitForResponse,
  validateWorkflowResult,
  provideCredentials,
  waitForAction,
  extractRequiredCredentials,
} from './test-utils';

export const n8nActionsSuite: TestSuite = {
  name: 'N8n Plugin Action Tests',
  tests: [
    {
      name: 'Test 1: Workflow generation from natural language',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Natural Language Workflow Generation Test ===');

        // Complex workflow request
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Generate a workflow that:
          1. Fetches weather data for 3 cities
          2. Gets stock prices for AAPL and GOOGL
          3. Searches for AI news
          4. Compiles everything into a report
          5. Sends the report via email`,
          180000
        );

        console.log('Workflow generation response:', response.text);

        // Provide necessary credentials
        const credentials = extractRequiredCredentials(response);
        if (credentials.length > 0) {
          const credMap: Record<string, string> = {};

          if (credentials.includes('OPENWEATHER_API_KEY')) {
            credMap.OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';
          }
          if (credentials.includes('ALPHA_VANTAGE_API_KEY')) {
            credMap.ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || '';
          }
          if (credentials.includes('NEWS_API_KEY')) {
            credMap.NEWS_API_KEY = process.env.NEWS_API_KEY || '';
          }
          if (credentials.includes('SENDGRID_API_KEY')) {
            credMap.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
          }

          const credResponse = await provideCredentials(runtime, room, user, credMap);
          console.log('After providing credentials:', credResponse.text);
        }

        // Verify workflow components
        validateWorkflowResult(response, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            trigger: 'schedule|cron|hourly',
            filter: 'filter|GPT|Claude',
            summarize: 'summary|summarize',
            database: 'database|store|save',
            email: 'email|digest|9.*AM',
          },
        });

        // Verify action was called
        const actionCalled = await waitForAction(runtime, 'GENERATE_WORKFLOW');
        assert(actionCalled, 'GENERATE_WORKFLOW action should be called');
      },
    },

    {
      name: 'Test 2: Workflow execution with parameters',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Parameterized Workflow Execution Test ===');

        // Create parameterized workflow
        const createResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a workflow that searches for news about a specific topic and filters by date range'
        );

        console.log('Workflow created:', createResponse.text);

        // Execute with parameters
        const execResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Execute the news search workflow with topic "quantum computing" and date range "last 7 days"',
          90000
        );

        console.log('Execution with parameters:', execResponse.text);

        // Verify parameters were used
        assert.match(
          execResponse.text || '',
          /quantum computing/i,
          'Should use provided topic parameter'
        );

        assert.match(
          execResponse.text || '',
          /7.*days|last.*week/i,
          'Should use provided date range'
        );

        // Verify execution action
        const actionCalled = await waitForAction(runtime, 'EXECUTE_WORKFLOW');
        assert(actionCalled, 'EXECUTE_WORKFLOW action should be called');
      },
    },

    {
      name: 'Test 3: Async action with progress tracking',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Async Action Progress Test ===');

        // Start long-running workflow
        const startResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Generate a comprehensive market analysis report for the tech sector including data collection, analysis, and visualization'
        );

        console.log('Async workflow started:', startResponse.text);

        // Verify async start
        assert.match(
          startResponse.text || '',
          /started|beginning|initiated|processing/i,
          'Should indicate async operation started'
        );

        // Extract job/execution ID
        const jobId = startResponse.text?.match(
          /job.*?([a-zA-Z0-9-]+)|execution.*?([a-zA-Z0-9-]+)/i
        )?.[1];

        // Check progress
        const progressResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `What's the status of the market analysis report${jobId ? ` (job ${jobId})` : ''}?`
        );

        console.log('Progress check:', progressResponse.text);

        // Verify progress tracking
        assert.match(
          progressResponse.text || '',
          /progress|status|complete|processing|%/i,
          'Should provide progress information'
        );
      },
    },

    {
      name: 'Test 4: Evaluator integration for workflow quality',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Workflow Evaluator Test ===');

        // Create a workflow
        const createResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a simple workflow to fetch and display weather data'
        );

        console.log('Workflow created:', createResponse.text);

        // Request evaluation
        const evalResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Evaluate the efficiency and reliability of the weather workflow'
        );

        console.log('Evaluation response:', evalResponse.text);

        // Verify evaluation metrics
        assert.match(
          evalResponse.text || '',
          /efficiency|performance|reliability|score|rating/i,
          'Should provide evaluation metrics'
        );

        // Check for recommendations
        assert.match(
          evalResponse.text || '',
          /recommend|suggest|improve|optimize/i,
          'Should provide improvement recommendations'
        );
      },
    },

    {
      name: 'Test 5: Workflow template usage',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Workflow Template Test ===');

        // Request template list
        const listResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Show me available n8n workflow templates for data processing'
        );

        console.log('Template list:', listResponse.text);

        // Use a template
        const templateResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Use the CSV to Database template to import customer data'
        );

        console.log('Template usage:', templateResponse.text);

        // Verify template was applied
        assert.match(
          templateResponse.text || '',
          /template|CSV.*database|import/i,
          'Should use the requested template'
        );

        // Check for customization options
        assert.match(
          templateResponse.text || '',
          /customize|configure|settings|parameters/i,
          'Should mention customization options'
        );
      },
    },

    {
      name: 'Test 6: Error handling and recovery',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Error Handling Test ===');

        // Create workflow with potential error
        const createResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a workflow that tries to fetch data from an API, and if it fails, sends an alert email and logs the error',
          90000
        );

        console.log('Workflow with error potential:', createResponse.text);

        // Execute and trigger error
        const errorResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Execute the workflow',
          60000
        );

        console.log('Error response:', errorResponse.text);

        // Verify error handling
        assert.match(
          errorResponse.text || '',
          /error|failed|credential|unauthorized|401/i,
          'Should report the error'
        );

        // Request fix
        const fixResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Fix the workflow by adding proper error handling and retry logic'
        );

        console.log('Fix response:', fixResponse.text);

        // Verify error handling was added
        assert.match(
          fixResponse.text || '',
          /error.*handling|retry|fallback|catch/i,
          'Should add error handling'
        );
      },
    },

    {
      name: 'Test 7: Workflow chaining and dependencies',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Workflow Chaining Test ===');

        // Create dependent workflows
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Create a workflow chain where:
          1. First workflow fetches user data from API
          2. Second workflow enriches data with location info
          3. Third workflow generates personalized content
          4. Fourth workflow sends personalized emails`,
          120000
        );

        console.log('Workflow chain response:', response.text);

        // Verify chain creation
        validateWorkflowResult(response, {
          expectSuccess: true,
          expectOutputs: {
            workflows: '4|four|multiple',
            chain: 'chain|connected|linked|depend',
            steps: 'fetch.*enrich.*generate.*send',
          },
        });

        // Test chain execution
        const execResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Execute the complete workflow chain for user ID 12345',
          180000
        );

        console.log('Chain execution:', execResponse.text);

        // Verify all steps executed
        assert.match(
          execResponse.text || '',
          /all.*steps.*complete|chain.*executed|4.*workflows/i,
          'Should execute entire chain'
        );
      },
    },

    {
      name: 'Test 8: Workflow optimization suggestions',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Workflow Optimization Test ===');

        // Create inefficient workflow
        const createResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Create a workflow that:
          - Fetches all records from database
          - Loops through each record
          - Makes individual API call for each record
          - Saves results one by one`
        );

        console.log('Inefficient workflow:', createResponse.text);

        // Request optimization
        const optimizeResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Analyze and optimize this workflow for better performance'
        );

        console.log('Optimization response:', optimizeResponse.text);

        // Verify optimization suggestions
        assert.match(
          optimizeResponse.text || '',
          /batch|bulk|parallel|optimize|improve.*performance/i,
          'Should suggest optimizations'
        );

        // Apply optimizations
        const applyResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Apply the suggested optimizations'
        );

        console.log('Applied optimizations:', applyResponse.text);

        // Verify improvements
        assert.match(
          applyResponse.text || '',
          /optimized|improved|faster|efficient/i,
          'Should confirm optimizations applied'
        );
      },
    },

    {
      name: 'Test 9: Webhook trigger management',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Webhook Trigger Management Test ===');

        // Create webhook-triggered workflow
        const createResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a webhook that receives JSON data and sends alerts via email when certain conditions are met',
          90000
        );

        console.log('Webhook creation response:', createResponse.text);

        // Note about tunnel requirement
        if (createResponse.text?.includes('webhook') && !createResponse.text?.includes('tunnel')) {
          console.log('Note: Local webhook testing requires tunnel service (e.g., ngrok)');
        }

        // Extract webhook URL
        const webhookUrl = createResponse.text?.match(/(https?:\/\/[^\s]+webhook[^\s]*)/i)?.[1];
        assert(webhookUrl, 'Should provide webhook URL');

        // Test webhook
        const testResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Test the webhook with sample order data: 
          { "orderId": "ORD-123", "items": [{"sku": "PROD-A", "quantity": 2}] }`
        );

        console.log('Webhook test:', testResponse.text);

        // Verify processing
        assert.match(
          testResponse.text || '',
          /processed|received|inventory.*updated/i,
          'Should process webhook data'
        );

        // Check webhook logs
        const logsResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Show me the webhook execution logs'
        );

        console.log('Webhook logs:', logsResponse.text);

        assert.match(
          logsResponse.text || '',
          /ORD-123|PROD-A|execution.*log/i,
          'Should show execution details'
        );
      },
    },

    {
      name: 'Test 10: Workflow version control',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Workflow Version Control Test ===');

        // Create initial workflow
        const v1Response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a workflow named "DataProcessor v1" that fetches and formats data'
        );

        console.log('Version 1:', v1Response.text);

        // Make changes
        const v2Response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Update DataProcessor to add data validation and error handling, save as v2'
        );

        console.log('Version 2:', v2Response.text);

        // Compare versions
        const compareResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Show me the differences between DataProcessor v1 and v2'
        );

        console.log('Version comparison:', compareResponse.text);

        // Verify version tracking
        assert.match(
          compareResponse.text || '',
          /v1.*v2|version.*1.*2|changes|differences/i,
          'Should show version differences'
        );

        assert.match(
          compareResponse.text || '',
          /validation|error.*handling|added/i,
          'Should show specific changes'
        );

        // Rollback test
        const rollbackResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Rollback DataProcessor to v1'
        );

        console.log('Rollback:', rollbackResponse.text);

        assert.match(
          rollbackResponse.text || '',
          /rollback|restored|v1|version.*1/i,
          'Should confirm rollback'
        );
      },
    },
  ],
};

export default n8nActionsSuite;
