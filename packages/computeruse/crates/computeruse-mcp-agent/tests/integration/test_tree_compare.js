#!/usr/bin/env node
/**
 * UI Tree Compare Test
 *
 * - Navigates to https://publicrecords.netronline.com/
 * - Captures window UI tree in Fast mode (include_detailed_attributes=false)
 * - Captures window UI tree in Complete mode (include_detailed_attributes=true)
 * - Compares duration, node count, and JSON size
 *
 * Usage:
 *   node examples/test_tree_compare.js
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

class UITreeCompareClient {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
  }

  async startMcpServer(port = 3004) {
    console.log(`🚀 Starting MCP server on port ${port}...`);
    const candidates = [
      path.join(__dirname, '../target/release/computeruse-mcp-agent.exe'),
      path.join(__dirname, '../target/release/computeruse-mcp-agent'),
      'target/release/computeruse-mcp-agent.exe',
      'target/release/computeruse-mcp-agent',
    ];
    let binaryPath = null;
    for (const p of candidates) { if (fs.existsSync(p)) { binaryPath = p; break; } }
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

  async connect(port = 3004) {
    const httpUrl = `http://127.0.0.1:${port}/mcp`;
    console.log(`🔌 Connecting to MCP server at ${httpUrl}...`);
    this.transport = new StreamableHTTPClientTransport(new URL(httpUrl));
    this.client = new Client({ name: 'ui-tree-compare-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    await this.client.connect(this.transport);
    await delay(300);
    console.log('✅ Connected to MCP server');
  }

  async callTool(name, args) {
    console.log(`\n🛠️  Calling tool: ${name}`);
    if (args && Object.keys(args).length) console.log('   Arguments:', JSON.stringify(args, null, 2));
    const started = Date.now();
    const result = await this.client.callTool({ name, arguments: args || {} });
    const elapsedMs = Date.now() - started;
    console.log(`✅ Tool ${name} returned ${result.content?.length ?? 0} content item(s) in ${elapsedMs}ms`);
    return { content: result.content, elapsedMs };
  }

  static parseFirstJson(content, label) {
    if (!content || content.length === 0) return null;
    const first = content[0];
    if (first.type === 'text') {
      try {
        const obj = JSON.parse(first.text);
        console.log(`\n📦 ${label} JSON keys:`, Object.keys(obj));
        return obj;
      } catch (e) {
        console.log(`\n📄 ${label} text (not JSON):`);
        console.log(first.text);
        return null;
      }
    }
    console.log(`\n📄 ${label} (non-text):`);
    console.log(first);
    return null;
  }

  static countNodes(node) {
    if (!node) return 0;
    let count = 1;
    if (Array.isArray(node.children)) {
      for (const child of node.children) count += UITreeCompareClient.countNodes(child);
    }
    return count;
  }

  async run() {
    // 1) Navigate
    const url = 'https://publicrecords.netronline.com/';
    await this.callTool('navigate_browser', { url });
    await delay(1500);

    // 2) Get applications list to find focused window PID
    const appsResult = await this.callTool('get_applications_and_windows_list', {});
    const appsJson = UITreeCompareClient.parseFirstJson(appsResult.content, 'Applications List');
    const apps = appsJson?.applications || [];
    const focusedApp = apps.find(app => app.is_focused);
    if (!focusedApp) throw new Error('No focused application found');
    const pid = focusedApp.pid;
    console.log(`📌 Focused window PID: ${pid} (${focusedApp.name})`);

    // 3) Window tree - Fast mode
    const fast = await this.callTool('get_window_tree', { pid, include_detailed_attributes: false });
    const fastJson = UITreeCompareClient.parseFirstJson(fast.content, 'get_window_tree (Fast)');
    const fastTree = fastJson?.ui_tree;
    const fastCount = UITreeCompareClient.countNodes(fastTree);
    const fastSize = fastTree ? JSON.stringify(fastTree).length : 0;

    // 4) Window tree - Complete mode
    const full = await this.callTool('get_window_tree', { pid, include_detailed_attributes: true });
    const fullJson = UITreeCompareClient.parseFirstJson(full.content, 'get_window_tree (Complete)');
    const fullTree = fullJson?.ui_tree;
    const fullCount = UITreeCompareClient.countNodes(fullTree);
    const fullSize = fullTree ? JSON.stringify(fullTree).length : 0;

    // 5) Print comparison
    console.log('\n📊 UI Tree Comparison');
    console.log('------------------------------------');
    console.log(`Fast mode   → time: ${fast.elapsedMs} ms, nodes: ${fastCount}, json bytes: ${fastSize}`);
    console.log(`Complete    → time: ${full.elapsedMs} ms, nodes: ${fullCount}, json bytes: ${fullSize}`);
  }

  async cleanup() {
    console.log('\n🧹 Cleaning up...');
    try { if (this.client) { await this.client.close(); this.client = null; } } catch {}
    try { if (this.transport) { await this.transport.close(); this.transport = null; } } catch {}
    if (this.serverProcess) {
      try { console.log('🛑 Stopping MCP server...'); this.serverProcess.kill('SIGTERM'); } catch {}
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
  console.log('🧪 MCP UI Tree Compare Test');
  const client = new UITreeCompareClient();
  try {
    await client.startMcpServer(3004);
    await client.connect(3004);
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

export { UITreeCompareClient };


