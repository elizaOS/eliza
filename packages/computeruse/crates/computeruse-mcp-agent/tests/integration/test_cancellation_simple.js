#!/usr/bin/env node
/**
 * Simple Request Cancellation Test
 * 
 * Tests the cancellation functionality with direct HTTP requests
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
  
  const serverProcess = spawn(binaryPath, ['--transport', 'http', '--port', '3005'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  
  await new Promise((resolve) => {
    serverProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log('Server:', output);
      if (output.includes('Press Ctrl+C')) {
        resolve();
      }
    });
  });
  
  console.log('✅ Server started\n');
  return serverProcess;
}

async function testStatus() {
  console.log('📋 Testing /status endpoint');
  const response = await fetch('http://127.0.0.1:3005/status');
  const data = await response.json();
  console.log('Status:', JSON.stringify(data, null, 2));
  console.log('');
}

async function testCancellation() {
  console.log('📋 Testing request cancellation');
  
  const controller = new AbortController();
  
  // Cancel after 500ms
  global.setTimeout(() => {
    console.log('🛑 Aborting request...');
    controller.abort();
  }, 500);
  
  try {
    const response = await fetch('http://127.0.0.1:3005/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': 'cancel-test-123',
        'X-Request-Timeout-Ms': '5000'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1.0.0'
          }
        },
        id: 1
      }),
      signal: controller.signal
    });
    
    console.log('Response received:', response.status);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('✅ Request successfully aborted');
    } else {
      console.log('Error:', error.message);
    }
  }
  console.log('');
}

async function testTimeout() {
  console.log('📋 Testing short timeout (100ms)');
  
  try {
    const response = await fetch('http://127.0.0.1:3005/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': 'timeout-test-456',
        'X-Request-Timeout-Ms': '100'  // Very short timeout
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test',
            version: '1.0.0'
          }
        },
        id: 2
      })
    });
    
    const data = await response.text();
    console.log('Response status:', response.status);
    if (response.status === 408) {
      console.log('✅ Request timed out as expected');
    }
  } catch (error) {
    console.log('Error:', error.message);
  }
  console.log('');
}

async function main() {
  const server = await startServer();
  
  try {
    await setTimeout(1000);
    
    await testStatus();
    await testCancellation();
    await testTimeout();
    await testStatus();
    
    console.log('✅ All tests completed');
  } finally {
    console.log('\n🧹 Shutting down server...');
    server.kill();
  }
}

main().catch(console.error);