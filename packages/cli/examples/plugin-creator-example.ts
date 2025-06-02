import { PluginCreator } from '../src/utils/plugins/creator';

/**
 * Example: Programmatic Plugin Creation
 *
 * This example demonstrates how to use the PluginCreator API
 * to generate ElizaOS plugins programmatically.
 */

async function createTimeTrackerPlugin() {
  // Make sure ANTHROPIC_API_KEY is set
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  // Define the plugin specification
  const spec = {
    name: 'time-tracker',
    description: 'A plugin to display current time and manage timezone offsets for ElizaOS agents',
    features: [
      "Display current time in agent's response",
      'Set and manage timezone offset',
      'Get time in different timezones',
      'Provide formatted time strings',
      'Track elapsed time between requests',
    ],
    actions: ['displayTime', 'setTimezoneOffset', 'getTimeInZone'],
    providers: ['currentTimeProvider', 'timezoneProvider'],
  };

  console.log('🚀 Starting plugin generation...');
  console.log('📝 Plugin specification:', JSON.stringify(spec, null, 2));

  // Create the plugin creator instance
  const creator = new PluginCreator({
    skipPrompts: true, // Don't show interactive prompts
    spec: spec, // Use our predefined specification
    // Optional: Skip validation for faster development iteration
    // skipTests: true,
    // skipValidation: true,
  });

  try {
    // Generate the plugin
    const result = await creator.create();

    if (result.success) {
      console.log('\n✅ Plugin generated successfully!');
      console.log(`📁 Plugin name: ${result.pluginName}`);
      console.log(`📍 Location: ${result.pluginPath}`);
      console.log('\n📋 Next steps:');
      console.log(`1. cd ${result.pluginPath}`);
      console.log('2. Review the generated code');
      console.log('3. Run tests: npm test');
      console.log('4. Build: npm run build');
      console.log('5. Add to your ElizaOS project');
    } else {
      console.error('\n❌ Plugin generation failed:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Unexpected error:', error);
    process.exit(1);
  }
}

// Alternative: Interactive plugin creation
async function createPluginInteractively() {
  console.log('🎯 Starting interactive plugin creation...');

  const creator = new PluginCreator({
    // No options - will prompt for everything
  });

  try {
    const result = await creator.create();

    if (result.success) {
      console.log('\n✅ Plugin created successfully!');
      console.log(`📁 Location: ${result.pluginPath}`);
    } else {
      console.error('\n❌ Plugin creation failed:', result.error);
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
  }
}

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check command line arguments
  const args = process.argv.slice(2);

  if (args.includes('--interactive')) {
    createPluginInteractively();
  } else {
    createTimeTrackerPlugin();
  }
}

export { createTimeTrackerPlugin, createPluginInteractively };
