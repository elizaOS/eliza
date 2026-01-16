#!/usr/bin/env node
/**
 * Stop Highlighting Test
 *
 * This script:
 * 1) Starts the MCP server
 * 2) Opens a clean page (example.com)
 * 3) Highlights the opened browser window for a long duration (30s)
 * 4) Stops the highlight early via the stop_highlighting tool
 * 5) Prints server/tool logs and responses
 *
 * Usage:
 *   node examples/test_stop_highlighting.js
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class StopHighlightingTest {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
  }

  async startMcpServer(port = 3003) {
    console.log(`🚀 Starting MCP server on port ${port}...`);

    const candidates = [
      path.join(__dirname, '../target/release/computeruse-mcp-agent.exe'),
      path.join(__dirname, '../target/release/computeruse-mcp-agent'),
      'target/release/computeruse-mcp-agent.exe',
      'target/release/computeruse-mcp-agent',
    ];

    let binaryPath = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        binaryPath = p;
        break;
      }
    }
    if (!binaryPath) throw new Error('❌ MCP binary not found. Build with: cargo build --release --bin computeruse-mcp-agent');

    console.log(`📁 Using binary: ${binaryPath}`);
    this.serverProcess = spawn(binaryPath, ['--transport', 'http', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: 'info', RUST_BACKTRACE: '1' },
    });

    this.serverProcess.stdout?.on('data', d => console.log(`[SERVER] ${d.toString().trim()}`));
    this.serverProcess.stderr?.on('data', d => console.error(`[SERVER ERROR] ${d.toString().trim()}`));
    this.serverProcess.on('exit', code => console.log(`[SERVER] exited with code ${code}`));

    console.log('⏳ Waiting for server to initialize...');
    await delay(3000);

    // Health check
    const healthUrl = `http://127.0.0.1:${port}/health`;
    const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    console.log('✅ Server health check passed');
  }

  async connect(port = 3003) {
    const httpUrl = `http://127.0.0.1:${port}/mcp`;
    console.log(`🔌 Connecting to MCP server at ${httpUrl}...`);

    this.transport = new StreamableHTTPClientTransport(new URL(httpUrl));
    this.client = new Client({ name: 'stop-highlighting-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    await this.client.connect(this.transport);
    await delay(500);
    console.log('✅ Connected to MCP server');
  }

  async callTool(name, args) {
    if (!this.client) throw new Error('MCP client not connected');
    console.log(`\n🛠️  Calling tool: ${name}`);
    if (args && Object.keys(args).length) console.log('   Arguments:', JSON.stringify(args, null, 2));
    const result = await this.client.callTool({ name, arguments: args || {} });
    console.log(`✅ Tool ${name} returned ${result.content?.length ?? 0} content item(s)`);
    return result.content;
  }

  static getFirstJson(content, label) {
    if (!content || content.length === 0) return null;
    const first = content[0];
    if (first.type === 'text') {
      try {
        const obj = JSON.parse(first.text);
        console.log(`\n📦 ${label} JSON:`);
        console.log(JSON.stringify(obj, null, 2));
        return obj;
      } catch {
        console.log(`\n📄 ${label} Text:`);
        console.log(first.text);
      }
    }
    return null;
  }

  async run() {
    console.log('\n' + '='.repeat(60));
    console.log('🎯 STOP HIGHLIGHTING TEST');
    console.log('='.repeat(60));

    // 1) Navigate to google.com (faster than example.com)
    const url = 'https://google.com';
    const navContent = await this.callTool('navigate_browser', { url, include_tree_after_action: false });
    const navJson = StopHighlightingTest.getFirstJson(navContent, 'navigate_browser');
    if (!navJson || !navJson.element || !navJson.element.suggested_selector) {
      throw new Error('Failed to get suggested_selector from navigate_browser response');
    }
    const targetSelector = navJson.element.suggested_selector;
    console.log(`🔎 Using suggested selector for highlight: ${targetSelector}`);

    // 2) Start a long highlight (30s) on the opened browser element
    const durationMs = 30000;
    const highlightArgs = {
      selector: targetSelector,
      color: 0x00FF00,        // Bright green (BGR)
      duration_ms: durationMs,
      text: 'DEMO',
      text_position: 'TopRight',
      include_tree_after_action: false,
      include_detailed_attributes: false,
    };
    const hlContent = await this.callTool('highlight_element', highlightArgs);
    StopHighlightingTest.getFirstJson(hlContent, 'highlight_element');
    console.log(`⏱️ Highlight requested for ${durationMs} ms. Waiting 3 seconds before stopping...`);
    await delay(3000);

    // 3) Stop the highlight early
    console.log('🛑 Calling stop_highlighting to end highlight early...');
    const stopContent = await this.callTool('stop_highlighting', {});
    const stopJson = StopHighlightingTest.getFirstJson(stopContent, 'stop_highlighting');
    if (stopJson) {
      console.log(`✅ stop_highlighting -> highlights_stopped=${stopJson.highlights_stopped}`);
    }
  }

  async cleanup() {
    console.log('\n🧹 Cleaning up...');
    try { if (this.client) { await this.client.close(); this.client = null; } } catch {}
    try { if (this.transport) { await this.transport.close(); this.transport = null; } } catch {}
    if (this.serverProcess) {
      try {
        console.log('🛑 Stopping MCP server...');
        this.serverProcess.kill('SIGTERM');
      } catch {}
      await new Promise(resolve => {
        const timeoutId = globalThis.setTimeout(() => { try { this.serverProcess?.kill('SIGKILL'); } catch {} resolve(); }, 5000);
        this.serverProcess?.on('exit', () => { globalThis.clearTimeout(timeoutId); resolve(); });
      });
      this.serverProcess = null;
    }
    console.log('✅ Cleanup completed');
  }
}

async function main() {
  console.log('🧪 MCP Stop Highlighting Test');
  const client = new StopHighlightingTest();
  try {
    await client.startMcpServer(3003);
    await client.connect(3003);
    await client.run();
    console.log('\n🎉 Test completed successfully!');
  } catch (err) {
    console.error('\n💥 Test failed:', err);
    process.exit(1);
  } finally {
    await client.cleanup();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('💥 Unhandled error:', err); process.exit(1); });
}

export { StopHighlightingTest };


