#!/bin/bash

# Example: Programmatic Plugin Creation
# This example demonstrates how to use the PluginCreator API
# to generate ElizaOS plugins programmatically.

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to create time tracker plugin
create_time_tracker_plugin() {
    echo -e "${BLUE}🚀 Starting plugin generation...${NC}"
    
    # Check if ANTHROPIC_API_KEY is set
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo -e "${RED}❌ ANTHROPIC_API_KEY environment variable is required${NC}"
        echo "Please set it with: export ANTHROPIC_API_KEY='your-api-key'"
        exit 1
    fi
    
    # Check if we're in the CLI directory
    if [ ! -f "package.json" ] || ! grep -q "@elizaos/cli" "package.json"; then
        echo -e "${RED}❌ This script must be run from the packages/cli directory${NC}"
        exit 1
    fi
    
    # Create the plugin specification
    cat > /tmp/plugin-spec.json << 'EOF'
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
    
    echo -e "${BLUE}📝 Plugin specification:${NC}"
    cat /tmp/plugin-spec.json | jq '.' 2>/dev/null || cat /tmp/plugin-spec.json
    echo ""
    
    # Create a temporary Node.js script to call the plugin creator
    cat > /tmp/create-plugin.js << 'EOF'
import { PluginCreator } from './dist/utils/plugin-creator.js';
import fs from 'fs';

const spec = JSON.parse(fs.readFileSync('/tmp/plugin-spec.json', 'utf-8'));

async function createPlugin() {
    const creator = new PluginCreator({
        skipPrompts: true,
        spec: spec,
        // Skip validation for faster testing
        skipTests: true,
        skipValidation: true,
    });
    
    try {
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
            process.exit(0);
        } else {
            console.error('\n❌ Plugin generation failed:', result.error);
            process.exit(1);
        }
    } catch (error) {
        console.error('\n❌ Unexpected error:', error);
        process.exit(1);
    }
}

createPlugin();
EOF
    
    # Make sure we have the built CLI
    if [ ! -d "dist" ]; then
        echo -e "${YELLOW}Building CLI first...${NC}"
        npm run build
    fi
    
    # Run the plugin creator
    node /tmp/create-plugin.js
    
    # Clean up temporary files
    rm -f /tmp/plugin-spec.json /tmp/create-plugin.js
}

# Function for interactive plugin creation
create_plugin_interactively() {
    echo -e "${BLUE}🎯 Starting interactive plugin creation...${NC}"
    
    # Check if ANTHROPIC_API_KEY is set
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo -e "${RED}❌ ANTHROPIC_API_KEY environment variable is required${NC}"
        echo "Please set it with: export ANTHROPIC_API_KEY='your-api-key'"
        exit 1
    fi
    
    # Run the CLI command directly
    npx elizaos plugins generate
}

# Main execution
if [ "$1" == "--interactive" ]; then
    create_plugin_interactively
else
    create_time_tracker_plugin
fi 