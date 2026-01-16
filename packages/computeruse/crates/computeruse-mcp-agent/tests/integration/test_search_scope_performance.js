#!/usr/bin/env node
/**
 * Search Scope Performance Test
 * 
 * Compares search performance and accuracy between:
 * 1. Desktop-wide search (no scoping)
 * 2. Window-scoped search
 * 3. Application-scoped search variants
 * 
 * Measures timing and success rates for each approach.
 * 
 * Usage:
 *   node test_search_scope_performance.js
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

class SearchScopePerformanceTest {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
    this.results = [];
  }

  async startMcpServer(port = 3001) {
    console.log(`🚀 Starting MCP server on port ${port}...`);
    
    // Find the MCP binary
    const possiblePaths = [
      path.join(__dirname, '../../../target/release/computeruse-mcp-agent.exe'),
      'C:/Users/screenpipe-windows/computeruse/target/release/computeruse-mcp-agent.exe',
      path.join(__dirname, '../../target/release/computeruse-mcp-agent.exe'),
      'target/release/computeruse-mcp-agent.exe',
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
    
    // Start the server process with DEBUG logging
    this.serverProcess = spawn(binaryPath, [
      '--transport', 'http',
      '--port', port.toString()
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: 'debug',  // Enable debug logging to see search details
        RUST_BACKTRACE: '1'
      }
    });
    
    // Capture server output for timing analysis
    this.serverProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (output.includes('searching elements') || output.includes('Found') || output.includes('Search took')) {
        console.log(`[SEARCH DEBUG] ${output}`);
      }
    });
    
    this.serverProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      // Capture debug logs about searching
      if (output.includes('searching elements') || output.includes('Found') || output.includes('Search took') || output.includes('within:')) {
        console.log(`[SEARCH INFO] ${output}`);
      } else if (output.includes('ERROR')) {
        console.error(`[SERVER ERROR] ${output}`);
      }
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
          name: "search-scope-performance-test",
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

  async callToolWithTiming(name, arguments_, description) {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }
    
    console.log(`\n🔍 ${description}`);
    console.log(`   Tool: ${name}`);
    console.log(`   Selector: ${arguments_.selector || 'N/A'}`);
    
    const startTime = Date.now();
    
    try {
      const result = await this.client.callTool({
        name,
        arguments: arguments_ || {},
      });
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      console.log(`   ✅ SUCCESS in ${duration}ms`);
      
      // Parse result if it's click_element or validate_element
      let elementInfo = null;
      if (result.content && result.content.length > 0) {
        try {
          const parsed = JSON.parse(result.content[0].text);
          elementInfo = parsed.element || parsed.elements || parsed;
          if (elementInfo) {
            if (Array.isArray(elementInfo)) {
              console.log(`   Found: ${elementInfo.length} elements`);
            } else {
              console.log(`   Found: ${elementInfo.role || 'element'} "${elementInfo.name || 'unnamed'}"`);
            }
          }
        } catch (e) {
          // Not JSON, that's okay
        }
      }
      
      this.results.push({
        description,
        selector: arguments_.selector,
        success: true,
        duration,
        element: elementInfo
      });
      
      return { success: true, duration, result: result.content };
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      console.log(`   ❌ FAILED in ${duration}ms`);
      
      // Extract error details from MCP error
      let errorMsg = error.message;
      if (error.data && error.data.error) {
        errorMsg = error.data.error;
      }
      console.log(`   Error: ${errorMsg}`);
      
      this.results.push({
        description,
        selector: arguments_.selector,
        success: false,
        duration,
        error: errorMsg
      });
      
      return { success: false, duration, error: errorMsg };
    }
  }

  async testSearchScopes() {
    console.log('='.repeat(60));
    console.log('🏃 SEARCH SCOPE PERFORMANCE TEST');
    console.log('='.repeat(60));
    console.log('');
    console.log('Testing different search scopes for NETR Online Florida link');
    console.log('Prerequisites: Chrome with NETR Online page should be open');
    console.log('');
    
    const testCases = [
      // 1. Desktop-wide search (slowest, least precise)
      {
        description: 'Desktop-wide search (no scoping)',
        selector: 'role:hyperlink|name:Florida'
      },
      
      // 2. Window-scoped search (good balance)
      {
        description: 'Window-scoped search (NETR window)',
        selector: 'role:Window|name:contains:NETR Online >> role:hyperlink|name:Florida'
      },
      
      // 3. Generic Chrome window search
      {
        description: 'Chrome window search (any Chrome window)',
        selector: 'role:Window|name:contains:Chrome >> role:hyperlink|name:Florida'
      },
      
      // 4. Application + direct hyperlink
      {
        description: 'Chrome Application → hyperlink (skip intermediate)',
        selector: 'role:Application|name:contains:Chrome >> role:hyperlink|name:Florida'
      },
      
      // 5. Application + Window + hyperlink
      {
        description: 'Chrome App → Window → hyperlink',
        selector: 'role:Application|name:contains:Chrome >> role:Window|name:contains:NETR >> role:hyperlink|name:Florida'
      },
      
      // 6. Document-scoped search
      {
        description: 'Document-scoped search',
        selector: 'role:Document >> role:hyperlink|name:Florida'
      },
      
      // 7. Group-scoped search (web content container)
      {
        description: 'Group container search',
        selector: 'role:Group|name:contains:NETR >> role:hyperlink|name:Florida'
      }
    ];
    
    // Also test tree inspection to understand structure
    console.log('📊 First, let\'s inspect the UI tree structure...\n');
    
    // Get applications list to find Chrome
    await this.callToolWithTiming(
      'get_applications',
      {},
      'Getting list of all applications'
    );
    
    await setTimeout(1000);
    
    // Now run all search tests using validate_element
    console.log('\n' + '='.repeat(60));
    console.log('🔬 RUNNING SEARCH SCOPE TESTS');
    console.log('='.repeat(60));
    
    for (const testCase of testCases) {
      await this.callToolWithTiming(
        'validate_element',
        { selector: testCase.selector },
        testCase.description
      );
      
      // Small delay between tests
      await setTimeout(500);
    }
    
    // Print summary
    this.printSummary();
  }

  printSummary() {
    console.log('\n' + '='.repeat(60));
    console.log('📈 PERFORMANCE SUMMARY');
    console.log('='.repeat(60));
    console.log('');
    
    // Sort by duration
    const sorted = [...this.results].sort((a, b) => a.duration - b.duration);
    
    console.log('🏆 FASTEST TO SLOWEST:');
    console.log('');
    
    sorted.forEach((result, index) => {
      const icon = result.success ? '✅' : '❌';
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
      console.log(`${medal} ${icon} ${result.duration.toString().padStart(5)}ms - ${result.description}`);
      if (result.selector) {
        console.log(`      Selector: ${result.selector}`);
      }
    });
    
    // Statistics
    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);
    
    console.log('\n📊 STATISTICS:');
    console.log(`   Success rate: ${successful.length}/${this.results.length} (${(successful.length/this.results.length*100).toFixed(1)}%)`);
    
    if (successful.length > 0) {
      const avgSuccess = successful.reduce((acc, r) => acc + r.duration, 0) / successful.length;
      const minSuccess = Math.min(...successful.map(r => r.duration));
      const maxSuccess = Math.max(...successful.map(r => r.duration));
      
      console.log(`   Successful searches:`);
      console.log(`     • Average: ${avgSuccess.toFixed(0)}ms`);
      console.log(`     • Fastest: ${minSuccess}ms`);
      console.log(`     • Slowest: ${maxSuccess}ms`);
    }
    
    console.log('\n💡 KEY INSIGHTS:');
    console.log('   1. Window-scoped searches are typically fastest and most reliable');
    console.log('   2. Desktop-wide searches are slowest (searching entire UI tree)');
    console.log('   3. Application-scoped searches work but depend on correct hierarchy');
    console.log('   4. Simpler selector chains often perform better');
    console.log('   5. Use "contains:" for partial matching to handle dynamic titles');
    
    console.log('\n🎯 RECOMMENDED APPROACH:');
    console.log('   For browser automation, use:');
    console.log('   • role:Window|name:contains:[PageTitle] >> role:element|name:target');
    console.log('   • This balances precision, performance, and reliability');
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
  console.log('🧪 MCP Search Scope Performance Test');
  console.log('Comparing search performance across different scoping strategies\n');
  
  const client = new SearchScopePerformanceTest();
  
  try {
    // Start the MCP server
    await client.startMcpServer(3001);
    
    // Connect to the server
    await client.connect(3001);
    
    // Run the test
    await client.testSearchScopes();
    
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

export { SearchScopePerformanceTest };

