/**
 * N8n Plugin Creation Tests
 * Tests using n8n workflows to dynamically create plugins
 */

import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import {
  setupScenario,
  sendMessageAndWaitForResponse,
  validateWorkflowResult,
  provideCredentials,
} from './test-utils';

// Plugin specifications from the auton8n tests
const TIME_PLUGIN_SPEC = {
  name: '@elizaos/plugin-time',
  description: 'Provides current time and timezone information',
  version: '1.0.0',
  actions: [
    {
      name: 'getCurrentTime',
      description: 'Get current time in any timezone',
      parameters: {
        timezone: 'string',
      },
    },
    {
      name: 'convertTime',
      description: 'Convert time between timezones',
      parameters: {
        time: 'string',
        fromTimezone: 'string',
        toTimezone: 'string',
      },
    },
  ],
  providers: [
    {
      name: 'timeProvider',
      description: 'Provides current time context',
      dataStructure: {
        currentTime: 'string',
        timezone: 'string',
        utcOffset: 'number',
      },
    },
  ],
};

const ASTRAL_CHART_SPEC = {
  name: '@elizaos/plugin-astral',
  description: 'Calculate astral charts using astronomical algorithms',
  version: '1.0.0',
  actions: [
    {
      name: 'calculateChart',
      description: 'Calculate natal chart for given birth data',
      parameters: {
        birthDate: 'string',
        birthTime: 'string',
        latitude: 'number',
        longitude: 'number',
      },
    },
    {
      name: 'getPlanetPositions',
      description: 'Get current planetary positions',
      parameters: {
        date: 'string',
        observer: {
          latitude: 'number',
          longitude: 'number',
        },
      },
    },
  ],
  dependencies: {
    astronomia: '^4.1.1',
  },
};

const SHELL_COMMAND_SPEC = {
  name: '@elizaos/plugin-shell',
  description: 'Execute shell commands and curl requests safely',
  version: '1.0.0',
  actions: [
    {
      name: 'executeCommand',
      description: 'Run shell command with safety checks',
      parameters: {
        command: 'string',
        args: 'string[]',
        cwd: 'string',
      },
    },
    {
      name: 'curlRequest',
      description: 'Make HTTP request via curl',
      parameters: {
        url: 'string',
        method: 'string',
        headers: 'object',
        data: 'string',
      },
    },
  ],
  services: [
    {
      name: 'ShellService',
      description: 'Manages shell execution with security',
      methods: ['execute', 'validateCommand', 'auditLog'],
    },
  ],
  environmentVariables: [
    {
      name: 'SHELL_WHITELIST',
      description: 'Comma-separated list of allowed commands',
      required: false,
      sensitive: false,
    },
  ],
};

export const n8nPluginCreationSuite: TestSuite = {
  name: 'N8n Plugin Creation Tests',
  tests: [
    {
      name: 'Test 1: Create Time Plugin via N8n Workflow',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Time Plugin Creation via N8n ===');

        // Request plugin creation through n8n
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Create a plugin using n8n workflow with this specification: ${JSON.stringify(TIME_PLUGIN_SPEC, null, 2)}`,
          120000 // 2 minute timeout
        );

        console.log('Plugin creation response:', response.text);

        // Verify n8n workflow was created and executed
        validateWorkflowResult(response, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            pluginName: TIME_PLUGIN_SPEC.name,
            status: 'created|generating|deploying',
            components: 'actions.*providers',
          },
        });

        // Check if AI generation API key is needed
        if (response.text?.includes('ANTHROPIC_API_KEY') || response.text?.includes('AI')) {
          const credResponse = await provideCredentials(runtime, room, user, {
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test-key',
          });

          console.log('After providing AI credentials:', credResponse.text);

          // Verify plugin generation completed
          assert.match(
            credResponse.text || '',
            /plugin.*created|generated.*successfully|completed/i,
            'Plugin should be generated'
          );
        }

        // Verify plugin structure was created
        assert.match(
          response.text || '',
          /time.*plugin|timezone.*actions|getCurrentTime/i,
          'Should reference time plugin components'
        );
      },
    },

    {
      name: 'Test 2: Create Astral Plugin with Dependencies',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Astral Plugin Creation with Dependencies ===');

        // Request astral plugin creation
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Use n8n to create an astral chart plugin with these specs: ${JSON.stringify(ASTRAL_CHART_SPEC, null, 2)}`,
          150000 // 2.5 minute timeout for complex plugin
        );

        console.log('Astral plugin response:', response.text);

        // Verify workflow handled dependencies
        validateWorkflowResult(response, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            pluginName: ASTRAL_CHART_SPEC.name,
            dependencies: 'astronomia',
            actions: 'calculateChart.*getPlanetPositions',
          },
        });

        // Verify dependency handling
        assert.match(
          response.text || '',
          /dependencies.*added|astronomia.*installed|external.*library/i,
          'Should handle external dependencies'
        );
      },
    },

    {
      name: 'Test 3: Shell Plugin Security Rejection',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Shell Plugin Security Check ===');

        // Request shell plugin creation
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Create a shell command execution plugin via n8n: ${JSON.stringify(SHELL_COMMAND_SPEC, null, 2)}`,
          60000
        );

        console.log('Shell plugin response:', response.text);

        // Verify security rejection or warning
        const isRejected = response.text?.match(
          /security.*risk|rejected|not.*allowed|dangerous|shell.*execution.*blocked/i
        );

        const hasWarning = response.text?.match(
          /warning|caution|security.*consideration|restricted/i
        );

        assert(
          isRejected || hasWarning,
          'Shell plugin should be rejected or have security warnings'
        );

        // If not rejected, verify security measures
        if (!isRejected && hasWarning) {
          assert.match(
            response.text || '',
            /whitelist|sandbox|restricted.*commands|security.*measures/i,
            'Should mention security measures if allowed'
          );
        }

        console.log('✓ Security check passed:', isRejected ? 'Rejected' : 'Warning issued');
      },
    },

    {
      name: 'Test 4: Batch Plugin Creation Workflow',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Batch Plugin Creation Test ===');

        // Request multiple plugins at once
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Create an n8n workflow that can generate multiple plugins from a list. Test it with: 
          1. A weather plugin
          2. A calculator plugin
          3. A reminder plugin`,
          180000 // 3 minute timeout
        );

        console.log('Batch creation response:', response.text);

        // Verify batch workflow creation
        validateWorkflowResult(response, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            plugins: '3|three|multiple',
            status: 'batch.*process|creating.*multiple|queue',
          },
        });

        // Check for plugin mentions
        const pluginTypes = ['weather', 'calculator', 'reminder'];
        let mentionedCount = 0;

        pluginTypes.forEach((type) => {
          if (response.text?.toLowerCase().includes(type)) {
            mentionedCount++;
          }
        });

        assert(
          mentionedCount >= 2,
          `Should mention at least 2 of the requested plugin types (found ${mentionedCount})`
        );
      },
    },

    {
      name: 'Test 5: Plugin Template Library Integration',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Plugin Template Library Test ===');

        // Request template-based plugin creation
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Create an n8n workflow that uses plugin templates to speed up creation. Show me available templates.',
          90000
        );

        console.log('Template library response:', response.text);

        // Verify template system
        validateWorkflowResult(response, {
          expectSuccess: true,
          expectOutputs: {
            templates: 'template|starter|boilerplate|scaffold',
            categories: 'provider|action|service|utility',
          },
        });

        // Test using a template
        const templateResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Use the provider template to create a cryptocurrency price provider plugin',
          120000
        );

        console.log('Template usage response:', templateResponse.text);

        assert.match(
          templateResponse.text || '',
          /template.*applied|using.*provider.*template|based.*on.*template/i,
          'Should use template system'
        );

        assert.match(
          templateResponse.text || '',
          /crypto|price|provider/i,
          'Should create requested plugin type'
        );
      },
    },

    {
      name: 'Test 6: Plugin Validation and Testing Workflow',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Plugin Validation Workflow Test ===');

        // Create a validation workflow
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Create an n8n workflow that validates newly created plugins by:
          1. Checking TypeScript compilation
          2. Running tests
          3. Validating plugin structure
          4. Checking for required exports`,
          120000
        );

        console.log('Validation workflow response:', response.text);

        validateWorkflowResult(response, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            validation: 'validate|check|test|verify',
            steps: 'typescript|compile|test|structure|export',
          },
        });

        // Test the validation workflow
        const testResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Run the validation workflow on the time plugin we created earlier',
          90000
        );

        console.log('Validation test response:', testResponse.text);

        assert.match(
          testResponse.text || '',
          /validation.*complete|passed.*checks|valid.*plugin/i,
          'Should validate plugin'
        );
      },
    },

    {
      name: 'Test 7: Plugin Publishing Workflow',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== Plugin Publishing Workflow Test ===');

        // Create publishing workflow
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Create an n8n workflow for publishing completed plugins that:
          - Generates package.json
          - Creates README documentation
          - Prepares for npm publishing
          - Adds to plugin registry`,
          120000
        );

        console.log('Publishing workflow response:', response.text);

        validateWorkflowResult(response, {
          expectSuccess: true,
          expectWorkflowId: true,
          expectOutputs: {
            publish: 'publish|package|npm|registry',
            documentation: 'readme|docs|documentation',
          },
        });

        // Verify publishing steps
        const publishingSteps = ['package.json', 'README', 'npm', 'registry'];

        let stepsFound = 0;
        publishingSteps.forEach((step) => {
          if (response.text?.toLowerCase().includes(step.toLowerCase())) {
            stepsFound++;
          }
        });

        assert(stepsFound >= 3, `Should mention at least 3 publishing steps (found ${stepsFound})`);
      },
    },

    {
      name: 'Test 8: AI Model Selection for Plugin Generation',
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        console.log('=== AI Model Selection Test ===');

        // Test model selection
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          `Create an n8n workflow that lets me choose between different AI models for plugin generation:
          - Claude Sonnet for simple plugins
          - Claude Opus for complex plugins with multiple services
          - GPT-4 for plugins requiring web research`,
          90000
        );

        console.log('Model selection response:', response.text);

        validateWorkflowResult(response, {
          expectSuccess: true,
          expectOutputs: {
            models: 'sonnet|opus|gpt-4|claude|model',
            selection: 'choose|select|option|complexity',
          },
        });

        // Test using specific model
        const modelResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          'Use Claude Opus to create a complex blockchain integration plugin',
          120000
        );

        console.log('Model-specific response:', modelResponse.text);

        assert.match(
          modelResponse.text || '',
          /opus|complex|blockchain/i,
          'Should use requested model for complex plugin'
        );
      },
    },
  ],
};

export default n8nPluginCreationSuite;
