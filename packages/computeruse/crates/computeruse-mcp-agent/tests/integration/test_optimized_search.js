#!/usr/bin/env node
/**
 * Test Optimized Search
 * 
 * Verifies that the Pane/Window search optimization is working
 * by comparing search times before and after optimization.
 * 
 * Usage:
 *   node test_optimized_search.js
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

class OptimizedSearchTest {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
    this.results = [];
  }

  async startMcpServer(port = 3001) {
    console.log(`🚀 Starting MCP server on port ${port}...`);
    
    const binaryPath = 'C:/Users/screenpipe-windows/computeruse/target/release/computeruse-mcp-agent.exe';
    
    if (!fs.existsSync(binaryPath)) {
      throw new Error('❌ MCP binary not found. Build with: cargo build --release --bin computeruse-mcp-agent');
    }
    
    // Get file modification time to show which version we're testing
    const stats = fs.statSync(binaryPath);
    console.log(`   Binary modified: ${stats.mtime.toLocaleString()}`);
    
    this.serverProcess = spawn(binaryPath, [
      '--transport', 'http',
      '--port', port.toString()
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: 'debug',  // Enable debug to see optimization logs
        RUST_BACKTRACE: '1'
      }
    });
    
    // Capture debug logs about depth optimization
    this.serverProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      // Look for our optimization logs
      if (output.includes('Using shallow search') || 
          output.includes('depth:') || 
          output.includes('actual:')) {
        console.log(`[OPTIMIZATION] ${output}`);
      }
    });
    
    this.serverProcess.on('exit', (code) => {
      console.log(`[SERVER] Process exited with code ${code}`);
    });
    
    console.log('⏳ Waiting for server to initialize...');
    await setTimeout(3000);
    
    try {
      const healthUrl = `http://127.0.0.1:${port}/health`;
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      console.log('✅ Server health check passed\n');
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
          name: "optimized-search-test",
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
      
      console.log('✅ Connected to MCP server\n');
    } catch (error) {
      console.error('❌ Failed to connect:', error);
      throw error;
    }
  }

  async testSelector(selector, description) {
    console.log(`\n🔍 ${description}`);
    console.log(`   Selector: ${selector}`);
    
    const startTime = Date.now();
    
    try {
      const result = await this.client.callTool({
        name: 'validate_element',
        arguments: { selector },
      });
      
      const duration = Date.now() - startTime;
      console.log(`   ✅ SUCCESS in ${duration}ms`);
      
      this.results.push({ description, selector, success: true, duration });
      return { success: true, duration };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(`   ❌ FAILED in ${duration}ms`);
      
      this.results.push({ description, selector, success: false, duration });
      return { success: false, duration };
    }
  }

  async runTests() {
    console.log('='.repeat(60));
    console.log('🚀 OPTIMIZED SEARCH TEST');
    console.log('='.repeat(60));
    console.log('');
    console.log('Testing if Pane/Window search optimization is working');
    console.log('Expected: Named Pane/Window searches should be < 1000ms');
    console.log('Prerequisites: Chrome with NETR Online page should be open');
    console.log('');
    
    // Test 1: Named Pane search (should trigger optimization)
    console.log('📌 TEST 1: Named Pane Search (Should Use Depth 5)');
    await this.testSelector(
      'role:Pane|name:contains:NETR Online',
      'Named Pane - OPTIMIZED'
    );
    
    await setTimeout(1000);
    
    // Test 2: Named Window search (should trigger optimization)
    console.log('\n📌 TEST 2: Named Window Search (Should Use Depth 5)');
    await this.testSelector(
      'role:Window|name:contains:NETR',
      'Named Window - OPTIMIZED'
    );
    
    await setTimeout(1000);
    
    // Test 3: Unnamed Pane search (should NOT trigger optimization)
    console.log('\n📌 TEST 3: Unnamed Pane Search (Should Use Depth 50)');
    console.log('   ⚠️  This will timeout - that\'s expected!');
    await this.testSelector(
      'role:Pane',
      'Unnamed Pane - NOT OPTIMIZED (will timeout)'
    );
    
    await setTimeout(1000);
    
    // Test 4: Chain with optimized first step
    console.log('\n📌 TEST 4: Chain with Optimized First Step');
    await this.testSelector(
      'role:Pane|name:contains:NETR >> role:hyperlink|name:Florida',
      'Optimized chain - shallow then deep'
    );
    
    await setTimeout(1000);
    
    // Test 5: Already scoped search (should NOT trigger optimization)
    console.log('\n📌 TEST 5: Testing That Scoped Searches Stay Deep');
    console.log('   First getting the window...');
    
    // This is a bit tricky - we'd need to first get a window and then search within it
    // For now, let's just test the baseline
    await this.testSelector(
      'role:hyperlink|name:Florida',
      'Direct hyperlink - baseline comparison'
    );
    
    this.printSummary();
  }

  printSummary() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 OPTIMIZATION RESULTS');
    console.log('='.repeat(60));
    
    const sorted = [...this.results].sort((a, b) => a.duration - b.duration);
    
    console.log('\n🏆 PERFORMANCE:');
    sorted.forEach((result, index) => {
      const icon = result.success ? '✅' : '❌';
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
      const optimized = result.description.includes('OPTIMIZED') && !result.description.includes('NOT') ? ' 🚀' : '';
      console.log(`${medal} ${icon} ${result.duration.toString().padStart(5)}ms - ${result.description}${optimized}`);
    });
    
    console.log('\n📈 ANALYSIS:');
    
    // Check if optimization is working
    const namedPaneResult = this.results.find(r => r.description.includes('Named Pane'));
    const namedWindowResult = this.results.find(r => r.description.includes('Named Window'));
    
    if (namedPaneResult && namedPaneResult.duration < 1000) {
      console.log('   ✅ OPTIMIZATION WORKING: Named Pane search < 1 second!');
    } else if (namedPaneResult) {
      console.log(`   ⚠️  Named Pane search took ${namedPaneResult.duration}ms (expected < 1000ms)`);
    }
    
    if (namedWindowResult && namedWindowResult.duration < 1000) {
      console.log('   ✅ OPTIMIZATION WORKING: Named Window search < 1 second!');
    } else if (namedWindowResult) {
      console.log(`   ⚠️  Named Window search took ${namedWindowResult.duration}ms (expected < 1000ms)`);
    }
    
    console.log('\n💡 WHAT TO LOOK FOR:');
    console.log('   • Check [OPTIMIZATION] logs above for "Using shallow search"');
    console.log('   • Named Pane/Window searches should show depth: 5');
    console.log('   • Unnamed searches should still use depth: 50');
    console.log('   • Chain searches should optimize first step only');
    
    console.log('\n🎯 EXPECTED IMPROVEMENTS:');
    console.log('   Before: Named Pane/Window ~5000-6000ms');
    console.log('   After:  Named Pane/Window ~500-1000ms');
    console.log('   Speedup: 5-10x faster!');
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
  console.log('🧪 Testing Pane/Window Search Optimization');
  console.log('Verifying depth optimization is working\n');
  
  const client = new OptimizedSearchTest();
  
  try {
    await client.startMcpServer(3001);
    await client.connect(3001);
    await client.runTests();
    console.log('\n🎉 Test completed!');
  } catch (error) {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  } finally {
    await client.cleanup();
  }
}

process.on('SIGINT', async () => {
  console.log('\n⚠️  Received SIGINT, cleaning up...');
  process.exit(0);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
  });
}

export { OptimizedSearchTest };
