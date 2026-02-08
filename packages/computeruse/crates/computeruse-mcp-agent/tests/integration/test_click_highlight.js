#!/usr/bin/env node
/**
 * Click Highlight Test
 * 
 * Tests the new highlight_before_action feature for click_element by:
 * 1. Starting the MCP server
 * 2. Opening Calculator 
 * 3. Testing click with highlighting enabled
 * 4. Testing regular click for comparison
 * 
 * Usage:
 *   node test_click_highlight.js
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout } from 'timers/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ClickHighlightTest {
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
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        binaryPath = p;
        break;
      }
    }
    
    if (!binaryPath) {
      throw new Error('❌ MCP binary not found. Build with: cargo build --release --bin computeruse-mcp-agent');
    }
    
    console.log(`📁 Using binary: ${binaryPath}`);
    
    // Start the server process
    this.serverProcess = spawn(binaryPath, [
      '--transport', 'http',
      '--port', port.toString()
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: 'info',
        RUST_BACKTRACE: '1'
      }
    });
    
    // Log server output for debugging
    this.serverProcess.stdout?.on('data', (data) => {
      console.log(`[SERVER] ${data.toString().trim()}`);
    });
    
    this.serverProcess.stderr?.on('data', (data) => {
      console.error(`[SERVER ERROR] ${data.toString().trim()}`);
    });
    
    this.serverProcess.on('exit', (code) => {
      console.log(`[SERVER] Process exited with code ${code}`);
    });
    
    // Wait for server to start
    console.log('⏳ Waiting for server to initialize...');
    await setTimeout(3000);
    
    // Test server health
    try {
      const healthUrl = `http://127.0.0.1:${port}/health`;
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      console.log('✅ Server health check passed');
    } catch (error) {
      throw new Error(`Cannot reach MCP server: ${error}`);
    }
  }

  async connect(port = 3001) {
    const httpUrl = `http://127.0.0.1:${port}/mcp`;
    console.log(`🔌 Connecting to MCP server at ${httpUrl}...`);
    
    try {
      this.transport = new StreamableHTTPClientTransport(new URL(httpUrl));
      this.client = new Client(
        {
          name: "click-highlight-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );
      
      await this.client.connect(this.transport);
      await setTimeout(500);
      
      console.log('✅ Connected to MCP server');
    } catch (error) {
      console.error('❌ Failed to connect:', error);
      throw error;
    }
  }

  async callTool(name, arguments_) {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }
    
    console.log(`🛠️  Calling tool: ${name}`);
    if (arguments_ && Object.keys(arguments_).length > 0) {
      console.log(`   Arguments:`, JSON.stringify(arguments_, null, 2));
    }
    
    try {
      const result = await this.client.callTool({
        name,
        arguments: arguments_ || {},
      });
      
      console.log(`✅ Tool ${name} completed successfully`);
      return result.content;
    } catch (error) {
      console.error(`❌ Tool ${name} failed:`, error);
      throw error;
    }
  }

  async testClickHighlighting() {
    console.log('\n' + '='.repeat(60));
    console.log('🎯 CLICK HIGHLIGHTING TEST');
    console.log('='.repeat(60));
    console.log('');
    console.log('This test will demonstrate the new highlight_before_action feature:');
    console.log('• Open Calculator');
    console.log('• Test click with bright green highlighting');
    console.log('• Test regular click for comparison');
    console.log('');
    
    try {
      // Step 1: Open Calculator
      console.log('📱 Opening Calculator...');
      const openResult = await this.callTool('open_application', {
        app_name: 'Calculator'
      });
      
      console.log('✅ Calculator opened');
      
      // Wait for Calculator to fully load
      await setTimeout(2000);
      
      // Step 2: Test click with highlighting
      console.log('\n🔥 Testing click_element with BRIGHT GREEN highlighting...');
      console.log('👀 Watch for a bright green border with "CLICK TEST" text!');
      
      const clickWithHighlightResult = await this.callTool('click_element', {
        selector: 'role:window|name:Calculator',
        highlight_before_action: {
          enabled: true,
          duration_ms: 1500,        // 1.5 seconds for easy visibility
          color: 0x00FF00,          // Bright green (BGR format)
          text: 'CLICK TEST',       // Custom overlay text
          text_position: 'Inside',  // Text inside the element
          font_style: {
            size: 16,
            bold: true,
            color: 0xFFFFFF         // White text
          }
        }
      });
      
      console.log('✅ Click with highlighting completed!');
      if (clickWithHighlightResult && clickWithHighlightResult.length > 0) {
        const result = JSON.parse(clickWithHighlightResult[0].text);
        console.log(`   Element clicked: ${result.element.role} "${result.element.name}"`);
        console.log(`   Selector used: ${result.selector_used}`);
      }
      
      // Wait a moment before next test
      await setTimeout(3000);
      
      // Step 3: Test regular click (no highlighting)
      console.log('\n🔵 Testing regular click_element (no highlighting)...');
      console.log('👀 This should click normally without any highlight');
      
      const regularClickResult = await this.callTool('click_element', {
        selector: 'role:window|name:Calculator'
        // No highlight_before_action parameter
      });
      
      console.log('✅ Regular click completed!');
      if (regularClickResult && regularClickResult.length > 0) {
        const result = JSON.parse(regularClickResult[0].text);
        console.log(`   Element clicked: ${result.element.role} "${result.element.name}"`);
        console.log(`   Selector used: ${result.selector_used}`);
      }
      
      // Step 4: Test highlighting with different settings
      console.log('\n🟡 Testing click with YELLOW highlighting and different settings...');
      console.log('👀 Watch for a yellow border with "YELLOW TEST" text on top!');
      
      await setTimeout(2000);
      
      const yellowHighlightResult = await this.callTool('click_element', {
        selector: 'role:window|name:Calculator',
        highlight_before_action: {
          enabled: true,
          duration_ms: 2000,        // 2 seconds
          color: 0x00FFFF,          // Yellow (BGR format)
          text: 'YELLOW TEST',      // Different text
          text_position: 'Top',     // Text above element
          font_style: {
            size: 14,
            bold: true,
            color: 0x000000         // Black text
          }
        }
      });
      
      console.log('✅ Yellow highlighting test completed!');
      
      // Summary
      console.log('\n' + '='.repeat(50));
      console.log('🎉 HIGHLIGHT TESTING SUMMARY');
      console.log('='.repeat(50));
      console.log('✅ Calculator opened successfully');
      console.log('✅ Click with green highlighting (1.5s, inside text)');
      console.log('✅ Regular click without highlighting');  
      console.log('✅ Click with yellow highlighting (2s, top text)');
      console.log('');
      console.log('🎯 Did you see the highlights?');
      console.log('  • Green border with "CLICK TEST" inside the element');
      console.log('  • No highlighting for the regular click');
      console.log('  • Yellow border with "YELLOW TEST" above the element');
      console.log('');
      console.log('If you saw the highlighting, the feature is working perfectly! 🚀');
      
    } catch (error) {
      console.error('❌ Click highlighting test failed:', error);
      throw error;
    }
  }

  async cleanup() {
    console.log('\n🧹 Cleaning up...');
    
    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
      }
      
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }
      
      if (this.serverProcess) {
        console.log('🛑 Stopping MCP server...');
        this.serverProcess.kill('SIGTERM');
        
        await new Promise((resolve) => {
          const timeoutId = globalThis.setTimeout(() => {
            console.log('⚠️  Force killing server process...');
            this.serverProcess?.kill('SIGKILL');
            resolve();
          }, 5000);
          
          this.serverProcess?.on('exit', () => {
            globalThis.clearTimeout(timeoutId);
            resolve();
          });
        });
        
        this.serverProcess = null;
      }
      
      console.log('✅ Cleanup completed');
      
    } catch (error) {
      console.error('⚠️  Error during cleanup:', error);
    }
  }
}

async function main() {
  console.log('🧪 MCP Click Highlighting Test');
  console.log('Testing highlight_before_action feature for click_element\n');
  
  const client = new ClickHighlightTest();
  
  try {
    // Start the MCP server
    await client.startMcpServer(3001);
    
    // Connect to the server
    await client.connect(3001);
    
    // Run the test
    await client.testClickHighlighting();
    
    console.log('\n🎉 Test completed successfully!');
    
  } catch (error) {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  } finally {
    await client.cleanup();
  }
}

// Handle process signals for cleanup
process.on('SIGINT', async () => {
  console.log('\n⚠️  Received SIGINT, cleaning up...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Received SIGTERM, cleaning up...');
  process.exit(0);
});

// Run the test
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
  });
}

export { ClickHighlightTest };

