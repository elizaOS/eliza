#!/usr/bin/env node
/**
 * Search Optimization Test
 * 
 * Demonstrates the performance impact of different search strategies:
 * 1. Deep tree search (current default)
 * 2. Application-first filtering
 * 3. Direct element search
 * 
 * Usage:
 *   node test_search_optimization.js
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

class SearchOptimizationTest {
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
      throw new Error('❌ MCP binary not found');
    }
    
    this.serverProcess = spawn(binaryPath, [
      '--transport', 'http',
      '--port', port.toString()
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: 'debug',
        RUST_BACKTRACE: '1'
      }
    });
    
    // Capture debug logs
    this.serverProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      // Log search-related debug info
      if (output.includes('searching') || 
          output.includes('found') || 
          output.includes('depth:') || 
          output.includes('within:') ||
          output.includes('timeout:')) {
        console.log(`[DEBUG] ${output}`);
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
          name: "search-optimization-test",
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
      console.log(`   Error: ${error.message?.substring(0, 100)}...`);
      
      this.results.push({ description, selector, success: false, duration });
      return { success: false, duration };
    }
  }

  async runTests() {
    console.log('='.repeat(60));
    console.log('🚀 SEARCH OPTIMIZATION TEST');
    console.log('='.repeat(60));
    console.log('');
    console.log('Testing search strategies for Chrome tabs');
    console.log('Prerequisites: Chrome with NETR Online page should be open');
    console.log('');
    
    // Strategy 1: Direct hyperlink search (baseline)
    console.log('\n📌 STRATEGY 1: Direct Element Search');
    console.log('   Searches entire desktop but for specific element type');
    await this.testSelector(
      'role:hyperlink|name:Florida',
      'Direct hyperlink search (desktop-wide)'
    );
    
    await setTimeout(1000);
    
    // Strategy 2: Traditional Pane search with contains
    console.log('\n📌 STRATEGY 2: Traditional Pane Search');
    console.log('   Searches all Panes (depth 50) with substring matching');
    await this.testSelector(
      'role:Pane|name:contains:NETR >> role:hyperlink|name:Florida',
      'Pane with contains (expensive)'
    );
    
    await setTimeout(1000);
    
    // Strategy 3: Window search instead of Pane
    console.log('\n📌 STRATEGY 3: Window-Level Search');
    console.log('   Searches Windows instead of Panes');
    await this.testSelector(
      'role:Window|name:contains:NETR >> role:hyperlink|name:Florida',
      'Window-scoped search'
    );
    
    await setTimeout(1000);
    
    // Strategy 4: Application-first approach
    console.log('\n📌 STRATEGY 4: Application-First Search');
    console.log('   Get application first, then search within');
    
    // First, get Chrome application
    const appStartTime = Date.now();
    try {
      const appResult = await this.client.callTool({
        name: 'get_applications',
        arguments: {}
      });
      const appDuration = Date.now() - appStartTime;
      console.log(`   Got applications list in ${appDuration}ms`);
      
      // Parse and find Chrome
      if (appResult.content && appResult.content.length > 0) {
        const apps = JSON.parse(appResult.content[0].text);
        const chromeApp = apps.find(app => 
          app.name?.toLowerCase().includes('chrome') || 
          app.process_name?.toLowerCase().includes('chrome')
        );
        console.log(`   Found Chrome: ${chromeApp ? 'Yes' : 'No'}`);
      }
    } catch (error) {
      console.log(`   Failed to get applications: ${error.message}`);
    }
    
    // Then search within Chrome
    await this.testSelector(
      'role:Application|name:Google Chrome >> role:hyperlink|name:Florida',
      'Application-scoped with exact name'
    );
    
    await setTimeout(1000);
    
    // Strategy 5: Document-based search
    console.log('\n📌 STRATEGY 5: Document-Based Search');
    console.log('   Focus on web document content');
    await this.testSelector(
      'role:Document >> role:hyperlink|name:Florida',
      'Document-scoped search'
    );
    
    await setTimeout(1000);
    
    // Strategy 6: Optimized - Use exact Pane name if known
    console.log('\n📌 STRATEGY 6: Exact Name Match');
    console.log('   Use exact name instead of contains');
    await this.testSelector(
      'role:Pane|name:NETR Online • Public Records, Search Records, Property Tax, Property Search, Assessor - Google Chrome >> role:hyperlink|name:Florida',
      'Exact Pane name (if known)'
    );
    
    this.printSummary();
  }

  printSummary() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 PERFORMANCE SUMMARY');
    console.log('='.repeat(60));
    
    const sorted = [...this.results].sort((a, b) => a.duration - b.duration);
    
    console.log('\n🏆 RESULTS (Fastest to Slowest):');
    sorted.forEach((result, index) => {
      const icon = result.success ? '✅' : '❌';
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
      console.log(`${medal} ${icon} ${result.duration.toString().padStart(5)}ms - ${result.description}`);
    });
    
    const successful = this.results.filter(r => r.success);
    
    console.log('\n📈 ANALYSIS:');
    console.log(`   Total tests: ${this.results.length}`);
    console.log(`   Successful: ${successful.length}`);
    
    if (successful.length > 0) {
      const avgTime = successful.reduce((acc, r) => acc + r.duration, 0) / successful.length;
      console.log(`   Average success time: ${avgTime.toFixed(0)}ms`);
    }
    
    console.log('\n💡 KEY INSIGHTS:');
    console.log('');
    console.log('🔴 CURRENT ISSUE: Pane/Window searches with depth=50');
    console.log('   • Searches 50 levels deep from desktop root');
    console.log('   • "contains:" does substring matching on EVERY element');
    console.log('   • Chrome tabs are Panes, but so are many other UI elements');
    console.log('');
    console.log('🟢 OPTIMIZATION OPPORTUNITIES:');
    console.log('   1. Use get_applications() first (only searches direct children)');
    console.log('   2. Use exact names when possible (avoid "contains:")');
    console.log('   3. Consider Window scope instead of Pane scope');
    console.log('   4. Direct element search can be faster for unique elements');
    console.log('');
    console.log('🎯 RECOMMENDED APPROACH:');
    console.log('   1. Get application first: get_applications() → filter for Chrome');
    console.log('   2. Search within app: Use app as root for subsequent searches');
    console.log('   3. Or use Window scope: role:Window|name:contains:NETR');
    console.log('   4. Or if element is unique: Direct search role:hyperlink|name:Florida');
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
  console.log('🧪 Search Optimization Test');
  console.log('Comparing different search strategies\n');
  
  const client = new SearchOptimizationTest();
  
  try {
    await client.startMcpServer(3001);
    await client.connect(3001);
    await client.runTests();
    console.log('\n🎉 Test completed successfully!');
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

export { SearchOptimizationTest };
