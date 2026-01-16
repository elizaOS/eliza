#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout } from 'timers/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ScrollHighlightTest {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
  }

  async startMcpServer(port = 3001) {
    console.log(`🚀 Starting MCP server on port ${port}...`);
    
    // Find the MCP binary
    const possiblePaths = [
      path.join(__dirname, '../target/release/computeruse-mcp-agent.exe'),
      path.join(__dirname, '../target/release/computeruse-mcp-agent'),
      'target/release/computeruse-mcp-agent.exe',
      'target/release/computeruse-mcp-agent',
    ];
    
    let binaryPath = null;
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        binaryPath = possiblePath;
        break;
      }
    }
    
    if (!binaryPath) {
      throw new Error('❌ Could not find computeruse-mcp-agent binary');
    }
    
    console.log(`📂 Using binary: ${binaryPath}`);
    
    this.serverProcess = spawn(binaryPath, ['--transport', 'http', '--port', port.toString()], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    this.serverProcess.stdout.on('data', (data) => {
      console.log(`📋 MCP: ${data.toString().trim()}`);
    });
    
    this.serverProcess.stderr.on('data', (data) => {
      console.log(`⚠️  MCP: ${data.toString().trim()}`);
    });
    
    this.serverProcess.on('error', (error) => {
      console.error('💥 Server process error:', error);
    });
    
    this.serverProcess.on('exit', (code, signal) => {
      console.log(`🛑 Server process exited with code ${code}, signal ${signal}`);
    });
    
    // Wait for server to start
    await setTimeout(2000);
    
    // Connect MCP client
    this.transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    this.client = new Client(
      {
        name: 'scroll-highlight-test',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );
    
    await this.client.connect(this.transport);
    console.log('✅ Connected to MCP server');
  }

  async callTool(name, args) {
    try {
      console.log(`🔧 Calling ${name} with args:`, JSON.stringify(args, null, 2));
      const result = await this.client.callTool({ name, arguments: args });
      console.log(`✅ ${name} succeeded`);
      return result;
    } catch (error) {
      console.error(`❌ ${name} failed:`, error);
      return null;
    }
  }

  async cleanup() {
    if (this.client) {
      await this.client.close();
    }
    if (this.serverProcess) {
      this.serverProcess.kill();
    }
  }
}

async function testScrollHighlight() {
    const test = new ScrollHighlightTest();
    
    try {
        // Start MCP server
        await test.startMcpServer();
        
        console.log('\n📜 === SCROLL ELEMENT HIGHLIGHT TESTS ===\n');
        
        // Test 1: Open Browser and navigate to Google search
        console.log('🌐 Opening browser and navigating to Google search...');
        await test.callTool('open_application', { app_name: 'chrome' });
        await setTimeout(3000);
        
        console.log('🔍 Navigating to Google search page...');
        await test.callTool('navigate_browser', { 
            url: 'https://www.google.com/search?q=netr+online&rlz=1C1PNBB_enUS1138US1147&oq=netr+online&gs_lcrp=EgZjaHJvbWUyCQgAEEUYORiABDIHCAEQABiABDIHCAIQABiABDIHCAMQABiABDIHCAQQABiABDIHCAUQABiABDINCAYQABiGAxiABBiKBTINCAcQABiGAxiABBiKBTIHCAgQABjvBdIBCTM4MjhqMGoxNagCCLACAfEF_KadEz1CTQzxBfymnRM9Qk0M&sourceid=chrome&ie=UTF-8'
        });
        await setTimeout(4000);
        
        // Test 2: Scroll down with purple highlighting 
        console.log('🟣 Test 1: Scroll DOWN with PURPLE highlight');
        await test.callTool('scroll_element', {
            selector: 'application|Google Chrome',  // Target the browser window directly
            direction: 'down',
            amount: 3,
            highlight_before_action: {
                enabled: true,
                duration_ms: 1500,
                color: 0xFF00FF,  // Purple (magenta)
                text: 'SCROLL ↓',
                text_position: 'Inside',
                font_style: {
                    size: 14,
                    bold: true,
                    color: 0xFFFFFF  // White text
                }
            }
        });
        await setTimeout(2000);
        
        // Test 3: Scroll up with orange highlighting
        console.log('\n🟠 Test 2: Scroll UP with ORANGE highlight');
        await test.callTool('scroll_element', {
            selector: 'application|Google Chrome',
            direction: 'up',
            amount: 2,
            highlight_before_action: {
                enabled: true,
                duration_ms: 2000,
                color: 0x0080FF,  // Orange
                text: 'SCROLL ↑',
                text_position: 'Top',
                font_style: {
                    size: 16,
                    bold: true,
                    color: 0x000000  // Black text
                }
            }
        });
        await setTimeout(2500);
        
        console.log('\n✅ Scroll highlighting tests completed!');
        
        console.log('\n🎉 All scroll highlighting tests completed!');
        
    } catch (error) {
        console.error('💥 Test failed:', error);
    } finally {
        await test.cleanup();
        console.log('\n🛑 Test cleanup completed');
    }
}

testScrollHighlight();
