#!/bin/bash

# Time Tracker Plugin Creator - Demo Version
# This script uses the elizaos CLI to generate a time tracking plugin
# Demo version with tests/validation skipped for faster execution

echo "==================================="
echo "ElizaOS Plugin Creator - DEMO"
echo "Time Tracker Plugin Example"
echo "==================================="
echo ""
echo "NOTE: This demo version skips tests and validation"
echo "      for faster execution. Use the full version"
echo "      for production-ready plugin generation."
echo ""

# For demo purposes, we'll check if API key is set but not require input
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ ANTHROPIC_API_KEY not found in environment"
    echo ""
    echo "This demo requires an API key to be set:"
    echo "  export ANTHROPIC_API_KEY='your-api-key'"
    echo ""
    echo "For security, we don't prompt for keys in demo mode."
    exit 1
else
    echo "✓ API key found in environment"
fi

# Check if Claude Code is installed
echo ""
echo "Checking for Claude Code..."
if ! command -v claude &> /dev/null; then
    echo "❌ Claude Code not found!"
    echo "Please install it first: npm install -g @anthropic-ai/claude-code"
    exit 1
else
    CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
    echo "✓ Claude Code is installed (version: $CLAUDE_VERSION)"
fi

# Create logs directory
LOG_DIR="./plugin-creator-demo-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"

echo ""
echo "Log directory: $LOG_DIR"
echo ""

# Navigate to the CLI directory
cd /Users/shawwalters/eliza/packages/cli

# Create spec file
SPEC_FILE="$LOG_DIR/time-tracker-spec.json"
cat > "$SPEC_FILE" << 'EOF'
{
  "name": "time-tracker",
  "description": "A plugin to display current time and manage timezone offsets for ElizaOS agents",
  "features": [
    "Display current time in agent's response",
    "Set and manage timezone offset", 
    "Get time in different timezones",
    "Provide formatted time strings",
    "Track elapsed time between requests"
  ],
  "actions": ["displayTime", "setTimezoneOffset", "getTimeInZone"],
  "providers": ["currentTimeProvider", "timezoneProvider"]
}
EOF

echo "✓ Plugin specification created"
echo ""

# Create a runner script that skips tests and validation
RUNNER_SCRIPT="$LOG_DIR/run-creator-demo.js"
cat > "$RUNNER_SCRIPT" << 'EOF'
import { PluginCreator } from './dist/utils/plugins/creator.js';
import fs from 'fs';

const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));

console.log('🚀 Starting DEMO plugin generation...');
console.log('📋 Plugin spec:', JSON.stringify(spec, null, 2));
console.log('\n⚡ Skipping tests and validation for faster demo\n');

const creator = new PluginCreator({
  skipPrompts: true,
  spec: spec,
  skipTests: true,      // Skip test validation for demo
  skipValidation: true, // Skip production validation for demo
});

(async () => {
  const startTime = Date.now();
  
  try {
    const result = await creator.create();
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    if (result.success) {
      console.log('\n✅ Plugin generated successfully!');
      console.log(`⏱️  Time taken: ${elapsed} seconds`);
      console.log(`📁 Plugin name: ${result.pluginName}`);
      console.log(`📍 Location: ${result.pluginPath}`);
      
      // Show some basic info about what was created
      const packageJsonPath = `${result.pluginPath}/package.json`;
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        console.log(`📦 Package: ${pkg.name} v${pkg.version}`);
      }
      
      process.exit(0);
    } else {
      console.error('\n❌ Plugin generation failed:', result.error);
      console.error(`⏱️  Failed after: ${elapsed} seconds`);
      process.exit(1);
    }
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error('\n❌ Unexpected error:', error);
    console.error(`⏱️  Failed after: ${elapsed} seconds`);
    process.exit(1);
  }
})();
EOF

# Run the plugin creator
echo "🚀 Running plugin creator in DEMO mode..."
echo "⚡ This will skip tests and validation"
echo ""

# Execute with timestamp
START_TIME=$(date +%s)
node "$RUNNER_SCRIPT" "$SPEC_FILE" 2>&1 | tee "$LOG_DIR/time-tracker.log"
RESULT=${PIPESTATUS[0]}
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "⏱️  Total execution time: ${ELAPSED} seconds"

# Check result
if [ $RESULT -eq 0 ]; then
    echo ""
    echo "✅ Demo completed successfully!"
    echo ""
    
    # Check if plugin was created
    EXPECTED_DIR="/Users/shawwalters/eliza/packages/cli/plugin-time-tracker"
    if [ -d "$EXPECTED_DIR" ]; then
        echo "📁 Plugin created at: $EXPECTED_DIR"
        echo ""
        echo "📊 Plugin structure:"
        cd "$EXPECTED_DIR"
        find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" \) | grep -v node_modules | sort | head -20
        
        echo ""
        echo "📝 To use this plugin:"
        echo "1. cd $EXPECTED_DIR"
        echo "2. npm install"
        echo "3. npm run build"
        echo "4. npm test"
        echo ""
        echo "⚠️  Note: Since we skipped tests/validation in demo mode,"
        echo "   you should run full tests before using in production."
    else
        echo "⚠️  Plugin directory not found at expected location"
        echo "   Check the logs for the actual location"
    fi
else
    echo ""
    echo "❌ Demo failed. Check the log file: $LOG_DIR/time-tracker.log"
    echo ""
    echo "Common issues:"
    echo "- Invalid API key"
    echo "- Claude Code not properly installed"
    echo "- Network connectivity issues"
    echo "- Insufficient disk space"
fi

echo ""
echo "📋 Full log available at: $LOG_DIR/time-tracker.log" 