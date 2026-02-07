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

class PressKeyHighlightTest {
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
        name: 'press-key-highlight-test',
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

async function testPressKeyHighlight() {
    const test = new PressKeyHighlightTest();
    
    try {
        // Start MCP server
        await test.startMcpServer();
        
        console.log('\n⌨️  === PRESS KEY HIGHLIGHT TESTS ===\n');
        
        // Test 1: Open Calculator
        console.log('📱 Opening Calculator...');
        await test.callTool('open_application', { app_name: 'Calculator' });
        await setTimeout(2000);
        
        // Test 2: Press key with bright blue highlighting 
        console.log('🔵 Test 1: Press ENTER with BLUE highlight');
        await test.callTool('press_key', {
            selector: 'role:window|name:Calculator',
            key: '{Enter}',
            highlight_before_action: {
                enabled: true,
                duration_ms: 1500,
                color: 0xFF0000,  // Bright blue
                text: 'ENTER',
                text_position: 'Inside',
                font_style: {
                    size: 14,
                    bold: true,
                    color: 0xFFFFFF  // White text
                }
            }
        });
        await setTimeout(2000);
        
        // Test 3: Press key with red highlighting
        console.log('🔴 Test 2: Press ESCAPE with RED highlight');
        await test.callTool('press_key', {
            selector: 'role:window|name:Calculator',
            key: '{Escape}',
            highlight_before_action: {
                enabled: true,
                duration_ms: 2000,
                color: 0x0000FF,  // Red
                text: 'ESC',
                text_position: 'Top',
                font_style: {
                    size: 16,
                    bold: true,
                    color: 0x00FFFF  // Yellow text
                }
            }
        });
        await setTimeout(2500);
        
        // Test 4: Press key without highlighting (regular operation)
        console.log('⚪ Test 3: Press TAB WITHOUT highlighting');
        await test.callTool('press_key', {
            selector: 'role:window|name:Calculator',
            key: '{Tab}'
        });
        await setTimeout(1000);
        
        // Test 5: Press key with green highlighting and custom text
        console.log('🟢 Test 4: Press CTRL+A with GREEN highlight');
        await test.callTool('press_key', {
            selector: 'role:window|name:Calculator',
            key: '{Ctrl}a',
            highlight_before_action: {
                enabled: true,
                duration_ms: 2500,
                color: 0x00FF00,  // Green
                text: 'CTRL+A',
                text_position: 'Bottom',
                font_style: {
                    size: 18,
                    bold: true,
                    color: 0x000000  // Black text
                }
            }
        });
        await setTimeout(3000);
        
        console.log('\n🎉 All press key highlighting tests completed!');
        
    } catch (error) {
        console.error('💥 Test failed:', error);
    } finally {
        await test.cleanup();
        console.log('\n🛑 Test cleanup completed');
    }
}

testPressKeyHighlight();
