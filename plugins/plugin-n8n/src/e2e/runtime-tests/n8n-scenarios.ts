/**
 * Comprehensive n8n plugin E2E test scenarios with real API workflows
 * These tests use actual API keys and validate real workflow execution
 */

import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import {
  setupScenario,
  sendMessageAndWaitForResponse,
  validateWorkflowResult,
  provideCredentials,
  setupTestEnvironment,
  cleanupTestEnvironment,
  extractRequiredCredentials,
} from './test-utils';

/**
 * Required environment variables for all tests
 * These should be set before running the test suite
 */
const REQUIRED_ENV_VARS = {
  // Core n8n credentials
  N8N_API_KEY: process.env.N8N_API_KEY!,
  N8N_BASE_URL: process.env.N8N_BASE_URL || 'http://localhost:5678',

  // API credentials for real workflows
  OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY!,
  ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY!,
  NEWS_API_KEY: process.env.NEWS_API_KEY!,
  DEEPL_API_KEY: process.env.DEEPL_API_KEY!,
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY!,
  TODOIST_API_KEY: process.env.TODOIST_API_KEY!,
  POSTGRES_CONNECTION_STRING: process.env.POSTGRES_CONNECTION_STRING!,
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL!,
  GOOGLE_SHEETS_CREDENTIALS: process.env.GOOGLE_SHEETS_CREDENTIALS!,
};

export const n8nScenariosSuite: TestSuite = {
  name: 'N8n Plugin Real Workflow Scenarios',
  tests: [
    {
      name: 'Scenario 1: Weather Data Provider with Real API',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Weather Data Provider Test ===');

        // Turn 1: User asks for weather
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "What's the current weather in New York City? I need temperature, humidity, and conditions."
        );

        console.log('Turn 1 - Agent:', response1.text);

        // Validation: Agent should mention creating/setting up workflow
        assert.match(
          response1.text || '',
          /workflow|weather service|set.*up|creating|configuring/i,
          'Agent should mention workflow setup'
        );

        // Turn 2: Check for credential requirements
        const requiredCreds = extractRequiredCredentials(response1);
        if (requiredCreds.length > 0 || response1.text?.includes('API')) {
          // Agent asks for credentials
          assert.match(
            response1.text || '',
            /OpenWeather|API.*key|credential/i,
            'Agent should request OpenWeather API key'
          );

          // User provides real API key
          const response2 = await provideCredentials(runtime, room, user, {
            OPENWEATHER_API_KEY: REQUIRED_ENV_VARS.OPENWEATHER_API_KEY,
          });

          console.log('Turn 2 - Agent:', response2.text);

          // Final validation of weather data
          validateWorkflowResult(response2, {
            expectSuccess: true,
            expectOutputs: {
              temperature: '\\d+',
              location: 'New York',
              conditions: '\\w+',
            },
          });

          // Verify actual weather data format
          assert.match(
            response2.text || '',
            /temperature.*\d+.*°[CF]/i,
            'Should include temperature with units'
          );
          assert.match(
            response2.text || '',
            /humidity.*\d+%/i,
            'Should include humidity percentage'
          );
        }
      },
    },

    {
      name: 'Scenario 2: Stock Price Provider with Alpha Vantage',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Stock Price Provider Test ===');

        // Turn 1: User asks for stock price
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Get me the current stock price for Apple (AAPL) including today's change and volume"
        );

        console.log('Turn 1 - Agent:', response1.text);

        // Turn 2: Provide Alpha Vantage credentials if needed
        if (response1.text?.includes('Alpha Vantage') || response1.text?.includes('API')) {
          const response2 = await provideCredentials(runtime, room, user, {
            ALPHA_VANTAGE_API_KEY: REQUIRED_ENV_VARS.ALPHA_VANTAGE_API_KEY,
          });

          console.log('Turn 2 - Agent:', response2.text);

          // Validate stock data
          validateWorkflowResult(response2, {
            expectSuccess: true,
            expectOutputs: {
              symbol: 'AAPL',
              price: '\\$\\d+',
              change: '[+-]\\d+\\.\\d+',
              volume: '\\d+',
            },
          });

          // Verify financial data format
          assert.match(
            response2.text || '',
            /\$\d+\.\d{2}/,
            'Should include properly formatted price'
          );
          assert.match(response2.text || '', /[+-]\d+\.\d+%?/, 'Should include change percentage');
        }
      },
    },

    {
      name: 'Scenario 3: News Search with Real-time Results',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== News Search Provider Test ===');

        // Turn 1: Search for news
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Search for the latest news about artificial intelligence and give me the top 3 headlines with sources',
          60000 // Extended timeout for search
        );

        console.log('Turn 1 - Agent:', response1.text);

        // Turn 2: Provide News API key if needed
        if (response1.text?.includes('News API') || response1.text?.includes('API key')) {
          const response2 = await provideCredentials(runtime, room, user, {
            NEWS_API_KEY: REQUIRED_ENV_VARS.NEWS_API_KEY,
          });

          console.log('Turn 2 - Agent:', response2.text);

          // Validate news results
          validateWorkflowResult(response2, {
            expectSuccess: true,
            expectOutputs: {
              headlines: '\\d+\\..*',
              sources: 'source:|from:',
            },
          });

          // Verify we got multiple headlines
          const headlineMatches = response2.text?.match(/\d+\./g);
          assert(
            headlineMatches && headlineMatches.length >= 3,
            'Should return at least 3 headlines'
          );
        }
      },
    },

    {
      name: 'Test 4: Translation Service with OpenAI',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Translation Test ===');

        // Request translation workflow
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'I need to translate some text to Spanish. Can you help with that?',
          30000
        );

        console.log('Translation setup response:', response.text);

        // Check if credentials are needed
        const credentials = extractRequiredCredentials(response);
        if (credentials.length > 0) {
          console.log('Providing OpenAI credentials...');

          const credResponse = await provideCredentials(runtime, room, user, {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
          });

          console.log('After providing credentials:', credResponse.text);
        }

        // Send text to translate
        const translateResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Please translate: "Hello, how are you today? The weather is beautiful."',
          60000
        );

        console.log('Translation response:', translateResponse.text);

        // Validate translation result
        validateWorkflowResult(translateResponse, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            language: 'spanish|español|es',
            translation: 'hola|cómo|tiempo|hermoso',
          },
        });

        // Verify Spanish translation
        assert.match(
          translateResponse.text?.toLowerCase() || '',
          /hola|cómo.*está|tiempo.*hermoso|clima/,
          'Response should contain Spanish translation'
        );

        console.log('✓ Translation test passed');
      },
    },

    {
      name: 'Scenario 5: Email Sending with SendGrid',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Email Sending Test ===');

        // Turn 1: Request to send email
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Send an email to test@example.com with subject "N8n Test" and body "This is an automated test from the n8n plugin e2e test suite. Timestamp: ' +
            new Date().toISOString() +
            '"'
        );

        console.log('Turn 1 - Agent:', response1.text);

        // Turn 2: Provide SendGrid credentials if needed
        if (response1.text?.includes('SendGrid') || response1.text?.includes('email')) {
          const response2 = await provideCredentials(runtime, room, user, {
            SENDGRID_API_KEY: REQUIRED_ENV_VARS.SENDGRID_API_KEY,
          });

          console.log('Turn 2 - Agent:', response2.text);

          // Validate email sent
          validateWorkflowResult(response2, {
            expectSuccess: true,
            expectOutputs: {
              recipient: 'test@example.com',
              subject: 'N8n Test',
              status: 'sent|delivered|queued',
            },
          });

          // Verify confirmation
          assert.match(
            response2.text || '',
            /email.*sent|message.*delivered|successfully.*sent/i,
            'Should confirm email was sent'
          );
        }
      },
    },

    {
      name: 'Scenario 6: Task Creation with Todoist',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Task Creation Test ===');

        // Turn 1: Create task
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a task in Todoist: "Complete n8n integration testing" with high priority, due tomorrow at 5 PM'
        );

        console.log('Turn 1 - Agent:', response1.text);

        // Turn 2: Provide Todoist credentials if needed
        if (response1.text?.includes('Todoist') || response1.text?.includes('API')) {
          const response2 = await provideCredentials(runtime, room, user, {
            TODOIST_API_KEY: REQUIRED_ENV_VARS.TODOIST_API_KEY,
          });

          console.log('Turn 2 - Agent:', response2.text);

          // Validate task creation
          validateWorkflowResult(response2, {
            expectSuccess: true,
            expectOutputs: {
              task: 'Complete n8n integration testing',
              priority: 'high|priority.*4',
              due: 'tomorrow|5.*PM',
            },
          });

          // Verify task ID or link
          assert.match(
            response2.text || '',
            /task.*created|task.*ID|todoist\.com/i,
            'Should confirm task creation with ID or link'
          );
        }
      },
    },

    {
      name: 'Scenario 7: Database Query and Report',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Database Query Test ===');

        // Turn 1: Request database report
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Query the database for user statistics: total users, active users in last 7 days, and new signups today',
          90000 // Extended timeout for database operations
        );

        console.log('Turn 1 - Agent:', response1.text);

        // Turn 2: Provide database credentials if needed
        if (response1.text?.includes('database') || response1.text?.includes('Postgres')) {
          const response2 = await provideCredentials(runtime, room, user, {
            POSTGRES_CONNECTION_STRING: REQUIRED_ENV_VARS.POSTGRES_CONNECTION_STRING,
          });

          console.log('Turn 2 - Agent:', response2.text);

          // Validate database results
          validateWorkflowResult(response2, {
            expectSuccess: true,
            expectOutputs: {
              totalUsers: 'total.*users.*\\d+',
              activeUsers: 'active.*\\d+',
              newSignups: 'new.*signup.*\\d+',
            },
          });

          // Verify numeric data
          const numbers = response2.text?.match(/\d+/g);
          assert(numbers && numbers.length >= 3, 'Should return at least 3 numeric statistics');
        }
      },
    },

    {
      name: 'Test 6: Webhook Handling with Slack (Requires Tunnel)',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Webhook Test (Slack) ===');
        console.log('Note: This test requires a tunnel service (e.g., ngrok) for local testing');

        // Request webhook workflow
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Set up a webhook to receive notifications and post them to Slack',
          30000
        );

        console.log('Webhook setup response:', response.text);

        // Check if tunnel is mentioned
        if (
          response.text?.includes('tunnel') ||
          response.text?.includes('ngrok') ||
          response.text?.includes('local')
        ) {
          console.log('✓ Agent correctly identified need for tunnel service');
        }

        // Check if credentials are needed
        const credentials = extractRequiredCredentials(response);
        if (credentials.includes('SLACK_WEBHOOK_URL')) {
          const credResponse = await provideCredentials(runtime, room, user, {
            SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || '',
          });

          console.log('After providing webhook:', credResponse.text);
        }

        // Validate webhook workflow
        validateWorkflowResult(response, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            webhook: 'webhook|endpoint|url|listen',
            notification: 'slack|notify|message',
          },
        });

        // Check for webhook URL in response
        assert.match(
          response.text || '',
          /webhook.*url|endpoint.*created|listening.*on|tunnel.*required/i,
          'Response should mention webhook endpoint or tunnel requirement'
        );

        console.log('✓ Webhook workflow test passed');
      },
    },

    {
      name: 'Test 7: Complex Multi-Step Workflow',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Complex Workflow Test ===');

        // Request a complex workflow combining multiple services
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a workflow that: 1) Gets weather for NYC, 2) If temperature > 70F, get tech news, 3) Translate the first headline to Spanish, 4) Send me an email with all results',
          180000 // 3 minute timeout
        );

        console.log('Complex workflow response:', response.text);

        // Provide all necessary credentials
        const credentials = extractRequiredCredentials(response);
        if (credentials.length > 0) {
          console.log(`Providing ${credentials.length} credentials...`);

          const credMap: Record<string, string> = {};
          if (credentials.includes('OPENWEATHER_API_KEY')) {
            credMap.OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';
          }
          if (credentials.includes('NEWS_API_KEY')) {
            credMap.NEWS_API_KEY = process.env.NEWS_API_KEY || '';
          }
          if (credentials.includes('OPENAI_API_KEY')) {
            credMap.OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
          }
          if (credentials.includes('SENDGRID_API_KEY')) {
            credMap.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
          }

          const credResponse = await provideCredentials(runtime, room, user, credMap);
          console.log('After providing all credentials:', credResponse.text);
        }

        // Validate complex workflow
        validateWorkflowResult(response, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            weather: 'weather|temperature|degrees',
            news: 'news|headline|article',
            translation: 'spanish|español|traducción',
            email: 'email|sent|delivered',
          },
        });

        // Verify workflow contains all components
        assert.match(
          response.text?.toLowerCase() || '',
          /weather.*news.*translat.*email|workflow.*complet.*steps/i,
          'Response should reference all workflow steps'
        );

        console.log('✓ Complex workflow test passed');
      },
    },

    {
      name: 'Test 8: Workflow Management and Control',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Workflow Management Test ===');

        // First create a simple workflow
        const createResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create a simple workflow that checks the weather every hour',
          60000
        );

        console.log('Workflow creation response:', createResponse.text);

        // Extract workflow ID if provided
        const workflowIdMatch = createResponse.text?.match(/workflow[_-]?id[:\s]+([a-zA-Z0-9-]+)/i);
        const workflowId = workflowIdMatch?.[1];

        // Test workflow operations
        const operations = [
          'List all my active workflows',
          workflowId ? `Get status of workflow ${workflowId}` : 'Get status of my latest workflow',
          'Disable the weather checking workflow',
        ];

        for (const operation of operations) {
          const opResponse = await sendMessageAndWaitForResponse(
            runtime,
            room,
            user,
            operation,
            30000
          );

          console.log(`Operation "${operation}" response:`, opResponse.text);

          // Verify operation was understood
          assert.match(
            opResponse.text || '',
            /workflow|status|disabled|active|list/i,
            `Response should relate to workflow management`
          );
        }

        console.log('✓ Workflow management test passed');
      },
    },
  ],
};

export default n8nScenariosSuite;
