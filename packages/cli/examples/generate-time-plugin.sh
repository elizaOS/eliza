#!/bin/bash

# Plugin Generator Demo Script - Time Tracker Plugin
# This script demonstrates how to use the AI-powered plugin generator

echo "==================================="
echo "ElizaOS Plugin Generator Demo"
echo "Creating a Time Tracker Plugin"
echo "==================================="
echo ""

# Check if API key is set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ ANTHROPIC_API_KEY not found!"
    echo ""
    echo "Please set your API key first:"
    echo "  export ANTHROPIC_API_KEY='your-api-key'"
    echo ""
    exit 1
fi

# Check if Claude Code is installed
if ! command -v claude &> /dev/null; then
    echo "❌ Claude Code not found!"
    echo "Please install it first: bun install -g @anthropic-ai/claude-code"
    exit 1
fi

echo "✅ Prerequisites checked"
echo ""

# Create a temporary directory for testing
TEST_DIR="./plugin-generation-test-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

echo "📁 Working directory: $TEST_DIR"
echo ""

# Create a spec file for non-interactive generation
cat > plugin-spec.json << 'EOF'
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
  "actions": [
    "displayTime",
    "setTimezoneOffset",
    "getTimeInZone"
  ],
  "providers": [
    "currentTimeProvider",
    "timezoneProvider"
  ]
}
EOF

echo "📝 Plugin specification created"
echo ""

# Run the plugin generator
echo "🚀 Starting plugin generation..."
echo "This will:"
echo "  1. Create plugin structure"
echo "  2. Generate all code with AI"
echo "  3. Run build and test loops"
echo "  4. Validate production readiness"
echo ""

# For demo purposes, we'll create a Node.js script that calls the CLI
cat > generate.js << 'EOF'
import { PluginCreator } from '@elizaos/cli/dist/utils/plugin-creator.js';
import fs from 'fs';

const spec = JSON.parse(fs.readFileSync('./plugin-spec.json', 'utf-8'));

console.log('Starting plugin generation with spec:', spec);

const creator = new PluginCreator({
  skipPrompts: true,
  spec: spec,
  // Uncomment these to skip validation for faster demo:
  // skipTests: true,
  // skipValidation: true,
});

try {
  const result = await creator.create();
  
  if (result.success) {
    console.log('\n✅ Plugin generated successfully!');
    console.log(`Plugin name: ${result.pluginName}`);
    console.log(`Location: ${result.pluginPath}`);
    process.exit(0);
  } else {
    console.error('\n❌ Plugin generation failed:', result.error);
    process.exit(1);
  }
} catch (error) {
  console.error('\n❌ Error:', error);
  process.exit(1);
}
EOF

# Run the generator
node generate.js

# Check if generation was successful
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Plugin generation completed!"
    echo ""
    echo "📁 Generated plugin structure:"
    
    # Show the generated structure
    if [ -d "plugin-time-tracker" ]; then
        cd plugin-time-tracker
        find . -type f -name "*.ts" -o -name "*.json" -o -name "*.md" | grep -v node_modules | sort
        
        echo ""
        echo "📄 Sample generated files:"
        echo ""
        echo "=== src/index.ts ==="
        head -20 src/index.ts 2>/dev/null || echo "(File preview not available)"
        
        echo ""
        echo "=== src/actions/displayTime.ts ==="
        head -20 src/actions/displayTime.ts 2>/dev/null || echo "(File preview not available)"
        
        echo ""
        echo "✨ Next steps:"
        echo "1. cd $TEST_DIR/plugin-time-tracker"
        echo "2. Review the generated code"
        echo "3. bun test (to run tests)"
        echo "4. bun run build (to build)"
        echo "5. Add to your ElizaOS project"
    fi
else
    echo ""
    echo "❌ Plugin generation failed"
    echo "Check the logs above for details"
fi

echo ""
echo "==================================="
echo "Demo complete!"
echo "===================================" 