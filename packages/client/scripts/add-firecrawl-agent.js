#!/usr/bin/env node

// Script to add the Firecrawl agent to the ElizaOS server
const fs = require('fs');
const path = require('path');

async function addFirecrawlAgent() {
    try {
        console.log('🚀 Adding Firecrawl Agent to ElizaOS...');

        // Read the character configuration
        const characterPath = path.join(__dirname, '../src/characters/firecrawl-agent.json');
        const characterConfig = JSON.parse(fs.readFileSync(characterPath, 'utf8'));

        console.log('📋 Character configuration loaded:', characterConfig.name);

        // Create the agent using the ElizaOS CLI
        const { execSync } = require('child_process');

        // Create a temporary character file in the expected location
        const tempCharacterPath = path.join(process.cwd(), 'firecrawl-agent.json');
        fs.writeFileSync(tempCharacterPath, JSON.stringify(characterConfig, null, 2));

        console.log('✅ Character file created at:', tempCharacterPath);
        console.log('📝 You can now use this character with ElizaOS by running:');
        console.log('   elizaos start --character firecrawl-agent.json');
        console.log('');
        console.log('🎯 Or add it to your ElizaOS server configuration.');

    } catch (error) {
        console.error('❌ Error adding Firecrawl agent:', error.message);
        process.exit(1);
    }
}

addFirecrawlAgent();
