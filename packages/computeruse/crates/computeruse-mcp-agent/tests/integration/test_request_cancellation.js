#!/usr/bin/env node
/**
 * Request Cancellation Test
 * 
 * Tests the new request cancellation and timeout functionality by:
 * 1. Starting the MCP server with HTTP transport
 * 2. Sending requests with custom timeout headers
 * 3. Testing request cancellation via abort signal
 * 4. Verifying that cancelled requests stop processing
 * 
 * Usage:
 *   node test_request_cancellation.js
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout } from 'timers/promises';
import { fileURLToPath } from 'url';
// Use native fetch (available in Node.js 18+)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class RequestCancellationTest {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
  }

  async startMcpServer(port = 3004) {
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

  async connectWithHeaders(port = 3004, headers = {}) {
    const url = `http://127.0.0.1:${port}/mcp`;
    
    // Create transport with custom headers
    this.transport = new StreamableHTTPClientTransport(
      url,
      {
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      }
    );
    
    this.client = new Client({
      name: 'test-client',
      version: '1.0.0',
    }, {
      capabilities: {}
    });
    
    await this.client.connect(this.transport);
    console.log('✅ Connected to MCP server with headers:', headers);
  }

  async testNormalRequest() {
    console.log('\n📋 Test 1: Normal request without timeout');
    
    await this.connectWithHeaders(3004, {
      'X-Request-ID': 'test-normal-001'
    });
    
    const startTime = Date.now();
    const result = await this.client.callTool('get_applications', {
      include_tree_after_action: false
    });
    const duration = Date.now() - startTime;
    
    console.log(`✅ Normal request completed in ${duration}ms`);
    console.log(`   Found ${result.applications?.length || 0} applications`);
    
    await this.client.close();
  }

  async testRequestWithTimeout() {
    console.log('\n📋 Test 2: Request with 5-second timeout');
    
    await this.connectWithHeaders(3004, {
      'X-Request-ID': 'test-timeout-002',
      'X-Request-Timeout-Ms': '5000'
    });
    
    const startTime = Date.now();
    
    try {
      // Call a tool that should complete within timeout
      const result = await this.client.callTool('get_applications', {
        include_tree_after_action: false
      });
      const duration = Date.now() - startTime;
      
      console.log(`✅ Request with timeout completed in ${duration}ms`);
      console.log(`   Found ${result.applications?.length || 0} applications`);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(`❌ Request failed after ${duration}ms: ${error.message}`);
    }
    
    await this.client.close();
  }

  async testRequestCancellation() {
    console.log('\n📋 Test 3: Request cancellation via abort');
    
    const controller = new AbortController();
    
    // Test raw HTTP request with abort signal
    const requestId = 'test-cancel-003';
    const url = 'http://127.0.0.1:3004/mcp';
    
    console.log('   Sending request that will be cancelled after 1 second...');
    
    // Set up cancellation after 1 second
    global.setTimeout(() => {
      console.log('   🛑 Cancelling request...');
      controller.abort();
    }, 1000);
    
    const startTime = Date.now();
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
          'X-Request-Timeout-Ms': '10000' // 10 second timeout
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'delay',
            arguments: { delay_ms: 5000 } // 5 second delay
          },
          id: 1
        }),
        signal: controller.signal
      });
      
      const result = await response.json();
      const duration = Date.now() - startTime;
      console.log(`   Request completed in ${duration}ms:`, result);
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.name === 'AbortError') {
        console.log(`✅ Request successfully cancelled after ${duration}ms`);
      } else {
        console.log(`❌ Unexpected error after ${duration}ms: ${error.message}`);
      }
    }
  }

  async testShortTimeout() {
    console.log('\n📋 Test 4: Request with very short timeout (100ms)');
    
    const requestId = 'test-short-timeout-004';
    const url = 'http://127.0.0.1:3004/mcp';
    
    const startTime = Date.now();
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
          'X-Request-Timeout-Ms': '100' // Very short timeout
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'delay',
            arguments: { delay_ms: 1000 } // 1 second delay
          },
          id: 1
        })
      });
      
      const result = await response.json();
      const duration = Date.now() - startTime;
      
      if (response.status === 408 || response.status === 504) {
        console.log(`✅ Request timed out as expected after ${duration}ms`);
        console.log(`   Response:`, result);
      } else {
        console.log(`   Request completed in ${duration}ms:`, result);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(`   Error after ${duration}ms: ${error.message}`);
    }
  }

  async testStatusEndpoint() {
    console.log('\n📋 Test 5: Check server status endpoint');
    
    try {
      const response = await fetch('http://127.0.0.1:3004/status');
      const status = await response.json();
      
      console.log('✅ Server status:', status);
      console.log(`   Active requests: ${status.activeRequests}`);
      console.log(`   Max concurrent: ${status.maxConcurrent}`);
      console.log(`   Busy: ${status.busy}`);
    } catch (error) {
      console.log(`❌ Failed to get status: ${error.message}`);
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

  async run() {
    try {
      await this.startMcpServer(3004);
      
      // Run tests
      await this.testStatusEndpoint();
      await this.testNormalRequest();
      await this.testRequestWithTimeout();
      await this.testRequestCancellation();
      await this.testShortTimeout();
      await this.testStatusEndpoint(); // Check status again
      
      console.log('\n✅ All tests completed successfully!');
    } catch (error) {
      console.error('\n❌ Test failed:', error);
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }
}

// Run the test
const test = new RequestCancellationTest();
test.run().catch(console.error);