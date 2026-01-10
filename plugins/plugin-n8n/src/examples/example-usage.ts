// import { Agent } from '@elizaos/core';
import { pluginDynamic } from '../index.ts';

/**
 * Example: Creating a Weather Plugin
 */
async function createWeatherPlugin(agent: any) {
  const weatherPluginSpec = {
    name: '@elizaos/plugin-weather',
    description: 'Weather information and forecasting plugin',
    version: '1.0.0',
    actions: [
      {
        name: 'getCurrentWeather',
        description: 'Get current weather for a location',
        parameters: {
          location: 'string',
          units: 'celsius | fahrenheit',
        },
      },
      {
        name: 'getWeatherForecast',
        description: 'Get weather forecast for the next 5 days',
        parameters: {
          location: 'string',
          days: 'number',
        },
      },
    ],
    providers: [
      {
        name: 'weatherData',
        description: 'Provides current weather data in context',
        dataStructure: {
          currentLocation: 'string',
          temperature: 'number',
          conditions: 'string',
          lastUpdated: 'timestamp',
        },
      },
    ],
    dependencies: {
      axios: '^1.6.0',
    },
    environmentVariables: [
      {
        name: 'WEATHER_API_KEY',
        description: 'API key for weather service',
        required: true,
        sensitive: true,
      },
    ],
  };

  // Simulate agent conversation
  console.log('User: Create a weather plugin with the following spec:');
  console.log(JSON.stringify(weatherPluginSpec, null, 2));

  // Agent would process this through the createPlugin action
  // const result = await agent.processMessage("Create plugin: " + JSON.stringify(weatherPluginSpec));
}

/**
 * Example: Creating a Plugin from Natural Language
 */
async function createTodoPlugin(agent: any) {
  const description = `
        I need a plugin that helps manage todo lists. It should have:
        - An action to add new todos with title and optional due date
        - An action to mark todos as complete
        - An action to list all todos with filtering options
        - A provider that shows pending todo count
        - Store todos in memory with persistence
    `;

  console.log('User:', description);

  // Agent would process this through the createPluginFromDescription action
  // const result = await agent.processMessage(description);
}

/**
 * Example: Monitoring Plugin Creation
 */
async function monitorPluginCreation(agent: any) {
  // Check status
  console.log("User: What's the status of my plugin creation?");

  // Agent would provide status through checkPluginCreationStatus action
  // Example response:
  console.log(`Agent: Plugin Creation Status: running
Current Phase: testing
Progress: 80%

Recent logs:
- Building plugin...
- Build successful
- Running tests...
- 12 tests passed
- Running validation...`);
}

/**
 * Example: Database Integration Plugin
 */
function getDatabasePluginSpec() {
  return {
    name: '@elizaos/plugin-postgres',
    description: 'PostgreSQL database integration',
    version: '1.0.0',
    services: [
      {
        name: 'PostgresService',
        description: 'Manages PostgreSQL connections and queries',
        methods: ['connect', 'disconnect', 'query', 'transaction'],
      },
    ],
    actions: [
      {
        name: 'executeQuery',
        description: 'Execute a SQL query',
        parameters: {
          query: 'string',
          params: 'array',
        },
      },
      {
        name: 'getDatabaseStats',
        description: 'Get database statistics and health',
        parameters: {},
      },
    ],
    evaluators: [
      {
        name: 'databaseHealth',
        description: 'Monitors database connection health',
        triggers: ['*/5 * * * *'], // Every 5 minutes
      },
    ],
    dependencies: {
      pg: '^8.11.0',
      'pg-pool': '^3.6.0',
    },
    environmentVariables: [
      {
        name: 'DATABASE_URL',
        description: 'PostgreSQL connection string',
        required: true,
        sensitive: true,
      },
      {
        name: 'DATABASE_POOL_SIZE',
        description: 'Maximum connection pool size',
        required: false,
        sensitive: false,
      },
    ],
  };
}

/**
 * Example: Social Media Integration Plugin
 */
function getSocialMediaPluginSpec() {
  return {
    name: '@elizaos/plugin-social',
    description: 'Social media integration plugin',
    version: '1.0.0',
    actions: [
      {
        name: 'postToTwitter',
        description: 'Post a message to Twitter/X',
        parameters: {
          message: 'string',
          mediaUrls: 'string[]',
        },
      },
      {
        name: 'schedulePost',
        description: 'Schedule a social media post',
        parameters: {
          platform: 'twitter | instagram | linkedin',
          message: 'string',
          scheduledTime: 'timestamp',
        },
      },
    ],
    providers: [
      {
        name: 'socialStats',
        description: 'Provides social media statistics',
        dataStructure: {
          followers: 'number',
          engagement: 'number',
          recentPosts: 'array',
        },
      },
    ],
  };
}

// Main execution
async function main() {
  // Initialize agent with plugin
  // This is just an example - in real usage, you would use the actual Agent class
  const agent = {
    name: 'PluginCreator',
    plugins: [pluginDynamic],
    // ... other configuration
  };

  // Example workflows
  console.log('=== Weather Plugin Example ===');
  await createWeatherPlugin(agent);

  console.log('\n=== Todo Plugin from Description ===');
  await createTodoPlugin(agent);

  console.log('\n=== Database Plugin Specification ===');
  console.log(JSON.stringify(getDatabasePluginSpec(), null, 2));

  console.log('\n=== Social Media Plugin Specification ===');
  console.log(JSON.stringify(getSocialMediaPluginSpec(), null, 2));
}

// Export examples for documentation
export {
  createWeatherPlugin,
  createTodoPlugin,
  monitorPluginCreation,
  getDatabasePluginSpec,
  getSocialMediaPluginSpec,
};

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
