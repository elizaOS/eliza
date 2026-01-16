#!/usr/bin/env node
/**
 * Netronline Highlight Scroll Test
 *
 * - Starts the MCP server (HTTP transport)
 * - Navigates to https://publicrecords.netronline.com/
 * - Highlights the footer link: "Do Not Sell or Share My Personal Information"
 *   (requires scrolling; exercises scroll-into-view logic in highlight)
 *
 * Usage:
 *   node examples/test_netronline_highlight.js
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

class NetronlineHighlightTest {
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

    const healthUrl = `http://127.0.0.1:${port}/health`;
    const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    console.log('✅ Server health check passed');
  }

  async connect(port = 3003) {
    const httpUrl = `http://127.0.0.1:${port}/mcp`;
    console.log(`🔌 Connecting to MCP server at ${httpUrl}...`);

    this.transport = new StreamableHTTPClientTransport(new URL(httpUrl));
    this.client = new Client({ name: 'netronline-highlight-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    await this.client.connect(this.transport);
    await delay(300);
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

  static printContentAsJson(content, label) {
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
    } else {
      console.log(`\n📄 ${label} (non-text):`);
      console.log(first);
    }
    return null;
  }

  async run() {
    // Step 1: Navigate to the target page
    const url = 'https://publicrecords.netronline.com/';
    console.log(`\n🌐 Navigating to: ${url}`);
    const navContent = await this.callTool('navigate_browser', { url });
    NetronlineHighlightTest.printContentAsJson(navContent, 'navigate_browser');

    // Delay to allow page to settle (requested 500ms)
    await delay(500);

    // Step 2: Switch to application | NETR Online ... - Google Chrome
    const appSelector = 'application|NETR Online • Public Records, Search Records, Property Tax, Property Search, Assessor - Google Chrome';
    console.log(`\n🪟 Activating application: ${appSelector}`);
    const activateContent = await this.callTool('activate_element', {
      selector: appSelector,
    });
    NetronlineHighlightTest.printContentAsJson(activateContent, 'activate_element');

    // Step 3: Highlight Florida link within the NETR pane (no click)
    const selector = 'role:Pane|name:contains:NETR Online • Public Records, Search Records, Property Tax, Property Search, Assessor >> role:hyperlink|name:Florida';
    console.log(`\n🎯 Highlighting selector: ${selector}`);
    const highlightContent = await this.callTool('highlight_element', {
      selector,
      color: 0x00FF00,        // Bright green border
      duration_ms: 3000,      // 3 seconds
      text: 'Target',         // Overlay text
      text_position: 'TopRight',
      include_tree_after_action: false,
      timeout_ms: 20000
    });
    NetronlineHighlightTest.printContentAsJson(highlightContent, 'highlight_element');
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
  console.log('🧪 Netronline Highlight Scroll Test');
  const client = new NetronlineHighlightTest();
  try {
    await client.startMcpServer(3003);
    await client.connect(3003);
    await client.run();
    console.log('\n🎉 Test completed');
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

export { NetronlineHighlightTest };


