#!/usr/bin/env node
/**
 * MCP Protocol Cancellation Test
 * 
 * Tests cancellation with proper MCP protocol messages
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout } from 'timers/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  console.log('🚀 Starting MCP server...');
  
  const binaryPath = 'C:/Users/screenpipe-windows/computeruse/target/release/computeruse-mcp-agent.exe';
  
  const serverProcess = spawn(binaryPath, ['--transport', 'http', '--port', '3006'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  
  await new Promise((resolve) => {
    serverProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log('Server:', output.trim());
      if (output.includes('Press Ctrl+C')) {
        resolve();
      }
    });
  });
  
  console.log('✅ Server started\n');
  return serverProcess;
}

async function testMcpCancellation() {
  console.log('📋 Testing MCP request cancellation with delay tool');
  
  const controller = new AbortController();
  
  // Cancel after 500ms
  global.setTimeout(() => {
    console.log('🛑 Aborting request...');
    controller.abort();
  }, 500);
  
  try {
    const response = await fetch('http://127.0.0.1:3006/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-Request-ID': 'mcp-cancel-test',
        'X-Request-Timeout-Ms': '5000'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'delay',
          arguments: { delay_ms: 2000 } // 2 second delay
        },
        id: 1
      }),
      signal: controller.signal
    });
    
    console.log('Response received:', response.status);
    const data = await response.text();
    console.log('Response body:', data);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('✅ Request successfully aborted by client');
    } else {
      console.log('Error:', error.message);
    }
  }
  console.log('');
}

async function testMcpTimeout() {
  console.log('📋 Testing MCP request with very short timeout');
  
  try {
    const response = await fetch('http://127.0.0.1:3006/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-Request-ID': 'mcp-timeout-test',
        'X-Request-Timeout-Ms': '100'  // 100ms timeout
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'delay',
          arguments: { delay_ms: 1000 } // 1 second delay
        },
        id: 2
      })
    });
    
    console.log('Response status:', response.status);
    const data = await response.text();
    
    if (response.status === 408) {
      console.log('✅ Request timed out as expected');
      console.log('Timeout response:', data);
    } else {
      console.log('Response body:', data);
    }
  } catch (error) {
    console.log('Error:', error.message);
  }
  console.log('');
}

async function testNormalMcpRequest() {
  console.log('📋 Testing normal MCP request (should succeed)');
  
  try {
    const response = await fetch('http://127.0.0.1:3006/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-Request-ID': 'mcp-normal-test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'delay',
          arguments: { delay_ms: 100 } // Short delay that should complete
        },
        id: 3
      })
    });
    
    console.log('Response status:', response.status);
    const data = await response.text();
    if (response.status === 200 || response.status === 202) {
      console.log('✅ Normal request succeeded');
    }
    console.log('Response:', data.substring(0, 100) + '...');
  } catch (error) {
    console.log('Error:', error.message);
  }
  console.log('');
}

async function main() {
  const server = await startServer();
  
  try {
    await setTimeout(1000);
    
    // Test normal request first
    await testNormalMcpRequest();
    
    // Test cancellation
    await testMcpCancellation();
    
    // Test timeout
    await testMcpTimeout();
    
    console.log('✅ All MCP cancellation tests completed');
  } finally {
    console.log('\n🧹 Shutting down server...');
    server.kill();
  }
}

main().catch(console.error);