#!/usr/bin/env node
/**
 * Streaming Logs Test
 * 
 * Tests whether console.log outputs are streamed during JavaScript execution
 * or only returned at the end
 * 
 * Usage:
 *   node test_streaming_logs.js
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

class StreamingLogsTest {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
    this.notifications = [];
    this.logTimestamps = [];
  }

  async startMcpServer(port = 3005) {
    console.log(`🚀 Starting MCP server on port ${port}...`);
    
    // Find the MCP binary
    const possiblePaths = [
      path.join(__dirname, '../../../target/release/computeruse-mcp-agent.exe'),
      path.join(__dirname, '../../../target/release/computeruse-mcp-agent'),
      'C:/Users/screenpipe-windows/computeruse/target/release/computeruse-mcp-agent.exe',
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
      throw new Error('MCP binary not found. Run: cargo build --release');
    }
    
    // Start server with HTTP transport
    this.serverProcess = spawn(binaryPath, ['--transport', 'http', '--port', port.toString()], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    
    // Wait for server to start
    await new Promise((resolve, reject) => {
      const timeout = global.setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, 10000);
      
      this.serverProcess.stderr.on('data', (data) => {
        const output = data.toString();
        console.log('Server:', output);
        if (output.includes('HTTP server running') || output.includes('Press Ctrl+C')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      
      this.serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    
    console.log('✅ MCP server started');
    await setTimeout(1000); // Give it a moment to stabilize
  }

  async connect(port = 3005) {
    const httpUrl = `http://127.0.0.1:${port}/mcp`;
    console.log(`🔌 Connecting to MCP server at ${httpUrl}...`);
    
    try {
      this.transport = new StreamableHTTPClientTransport(new URL(httpUrl));
      this.client = new Client(
        {
          name: "streaming-logs-test",
          version: "1.0.0"
        },
        {
          capabilities: {}
        }
      );
      
      // Connect first
      await this.client.connect(this.transport);
      
      // Note: StreamableHTTPClientTransport doesn't support real-time notifications
      // We'll test if logs are at least captured in the final result
      console.log('⚠️  Note: HTTP transport may not support streaming notifications');
      console.log('✅ Connected to MCP server');
      
      // Just verify connection by making a simple call
      console.log('📋 Testing connection with list_tools...');
      const tools = await this.client.request({
        method: 'tools/list'
      });
      console.log(`📦 Available tools: ${tools.tools?.length || 0} tools found`);
      
    } catch (error) {
      console.error('❌ Failed to connect:', error);
      throw error;
    }
  }

  async testStreamingWithDelays() {
    console.log('\n' + '='.repeat(60));
    console.log('📋 Testing if logs are streamed during execution...');
    console.log('='.repeat(60) + '\n');
    
    const startTime = Date.now();
    this.notifications = [];
    this.logTimestamps = [];
    
    // Script with deliberate delays
    const testScript = `
      console.log('LOG_1: Starting at ' + Date.now());
      await sleep(1000);
      console.log('LOG_2: After 1 second at ' + Date.now());
      await sleep(1000);
      console.log('LOG_3: After 2 seconds at ' + Date.now());
      await sleep(1000);
      console.log('LOG_4: Ending at ' + Date.now());
      return 'COMPLETED';
    `;
    
    console.log('🎬 Executing test script with 4 logs and 3-second total delay...\n');
    
    try {
      // Execute the script using the correct method
      const result = await this.client.request({
        method: 'tools/call',
        params: {
          name: 'run_command',
          arguments: {
            engine: 'javascript',
            run: testScript
          }
        }
      });
      
      const endTime = Date.now();
      const totalTime = endTime - startTime;
      
      // Analyze results
      console.log('\n' + '='.repeat(60));
      console.log('📊 ANALYSIS RESULTS:');
      console.log('='.repeat(60));
      console.log(`⏱️  Total execution time: ${totalTime}ms`);
      console.log(`📬 Notifications received: ${this.notifications.length}`);
      console.log(`📝 Log timestamps captured: ${this.logTimestamps.length}`);
      
      // Check if logs were streamed
      if (this.logTimestamps.length > 0) {
        const gaps = [];
        for (let i = 1; i < this.logTimestamps.length; i++) {
          gaps.push(this.logTimestamps[i] - this.logTimestamps[i-1]);
        }
        
        console.log(`\n⏰ Time gaps between logs: ${gaps.map(g => g + 'ms').join(', ')}`);
        
        // If gaps are ~1000ms, logs were streamed
        // If gaps are ~0ms, logs were batched
        const avgGap = gaps.reduce((a,b) => a+b, 0) / gaps.length || 0;
        
        console.log(`📈 Average gap: ${Math.round(avgGap)}ms`);
        
        if (avgGap > 500) {
          console.log('\n✅ STREAMING WORKS: Logs arrived with delays between them');
        } else {
          console.log('\n❌ NO STREAMING: All logs arrived at once (gaps < 500ms)');
        }
      } else {
        console.log('\n❌ NO NOTIFICATIONS: No log notifications received during execution');
        console.log('   Logs were only in final result:');
        console.log('   ', JSON.stringify(result).substring(0, 200));
      }
      
      // Show notification timeline
      if (this.notifications.length > 0) {
        console.log('\n' + '='.repeat(60));
        console.log('📅 NOTIFICATION TIMELINE:');
        console.log('='.repeat(60));
        this.notifications.forEach(n => {
          const relTime = n.timestamp - startTime;
          const marker = n.params?.message?.includes('LOG_') ? '🔴' : '⚪';
          console.log(`${marker} +${String(relTime).padStart(5)}ms: ${n.method}`);
          if (n.params?.message) {
            console.log(`            ${n.params.message.substring(0, 60)}`);
          }
        });
      }
      
      // Show final result
      console.log('\n' + '='.repeat(60));
      console.log('📦 FINAL RESULT FROM TOOL CALL:');
      console.log('='.repeat(60));
      console.log(JSON.stringify(result, null, 2).substring(0, 500));
      
    } catch (error) {
      console.error('❌ Test execution failed:', error);
      throw error;
    }
  }

  async cleanup() {
    console.log('\n🧹 Cleaning up...');
    
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        // Ignore errors during cleanup
      }
    }
    
    if (this.serverProcess) {
      this.serverProcess.kill();
      await setTimeout(500);
    }
    
    console.log('✅ Cleanup complete');
  }
}

// Run the test
async function main() {
  const test = new StreamingLogsTest();
  
  try {
    await test.startMcpServer();
    await test.connect();
    await test.testStreamingWithDelays();
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    await test.cleanup();
  }
}

main().catch(console.error);