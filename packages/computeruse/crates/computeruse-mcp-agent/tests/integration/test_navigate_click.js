#!/usr/bin/env node
/**
 * Navigate-and-Click Test
 *
 * - Opens a Google results URL (navigate_browser)
 * - Clicks the specified hyperlink (click_element)
 * - Waits 500 ms
 * - Prints full responses, including Windows-specific click_result (method, coordinates, details)
 *
 * Usage:
 *   node examples/test_navigate_click.js
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

class NavigateAndClickClient {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
  }

  async startMcpServer(port = 3002) {
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
    if (!binaryPath) throw new Error('❌ MCP binary not found. Build with: cargo build --release');

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

  async connect(port = 3002) {
    const httpUrl = `http://127.0.0.1:${port}/mcp`;
    console.log(`🔌 Connecting to MCP server at ${httpUrl}...`);

    this.transport = new StreamableHTTPClientTransport(new URL(httpUrl));
    this.client = new Client({ name: 'navigate-click-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    await this.client.connect(this.transport);
    await delay(300);
    console.log('✅ Connected to MCP server');
  }

  async callTool(name, args) {
    console.log(`\n🛠️  Calling tool: ${name}`);
    if (args && Object.keys(args).length) console.log('   Arguments:', JSON.stringify(args, null, 2));
    const result = await this.client.callTool({ name, arguments: args || {} });
    console.log(`✅ Tool ${name} returned ${result.content?.length ?? 0} content item(s)`);
    return result.content;
  }

  static printContentAsJson(content, label) {
    if (!content || content.length === 0) return;
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

  async runSequence() {
    // Step 1: navigate_browser
    const url = 'https://www.google.com/search?q=netr+online&rlz=1C1PNBB_enUS1138US1147&oq=netr+online&gs_lcrp=EgZjaHJvbWUyCQgAEEUYORiABDIHCAEQABiABDIHCAIQABiABDIHCAMQABiABDIHCAQQABiABDIHCAUQABiABDINCAYQABiGAxiABBiKBTINCAcQABiGAxiABBiKBTIHCAgQABjvBdIBCTM4MjhqMGoxNagCCLACAfEF_KadEz1CTQzxBfymnRM9Qk0M&sourceid=chrome&ie=UTF-8';
    const navContent = await this.callTool('navigate_browser', { url });
    const navJson = NavigateAndClickClient.printContentAsJson(navContent, 'navigate_browser');

    // Optional short settle to allow SERP to render
    await delay(1200);

    // Step 2: click_element
    const selector = 'role:hyperlink|name:contains:NETR Online • Public Records, Search Records, Property Tax';
    const clickContent = await this.callTool('click_element', { selector, timeout_ms: 10000, include_tree_after_action: false });
    const clickJson = NavigateAndClickClient.printContentAsJson(clickContent, 'click_element');

    // Highlight key click facts (Windows provides click_result with method/coordinates/details)
    if (clickJson && clickJson.click_result) {
      const { method, coordinates, details } = clickJson.click_result;
      console.log('\n🔎 Click Result Summary:');
      console.log(`   • method: ${method}`);
      console.log(`   • coordinates: ${coordinates ? `${coordinates[0]}, ${coordinates[1]}` : 'n/a'}`);
      console.log(`   • details: ${details}`);
    }

    // Step 3: post-click delay 500 ms
    await delay(500);
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
  console.log('🧪 MCP Navigate-and-Click Test');
  const client = new NavigateAndClickClient();
  try {
    await client.startMcpServer(3002);
    await client.connect(3002);
    await client.runSequence();
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

export { NavigateAndClickClient };


