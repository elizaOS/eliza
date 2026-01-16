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

    // Step 2.5: Refresh page to dismiss potential modal/popups
    console.log(`\n🔄 Refreshing page (F5) to dismiss modal if present`);
    const refreshContent = await this.callTool('press_key_global', {
      key: 'F5',
    });
    NetronlineHighlightTest.printContentAsJson(refreshContent, 'press_key_global');
    await delay(1000);

    // Step 2.6: Attempt to dismiss blocking JS alert modal repeatedly
    {
      const alertSelector = 'Window|publicrecords.netronline.com says';
      const okSelector = 'Window|publicrecords.netronline.com says >> role:button|name:OK';
      console.log(`\n🧹 Dismissing alert loop (max 5 tries) on: ${alertSelector}`);
      for (let i = 1; i <= 5; i++) {
        try {
          // Try click OK first (more reliable on JS alerts)
          const clickOk = await this.callTool('click_element', {
            selector: okSelector,
            timeout_ms: 800,
            include_tree_after_action: false,
          });
          NetronlineHighlightTest.printContentAsJson(clickOk, `click_element[try ${i}]`);
        } catch {}
        await delay(200);

        // Check if alert still present
        try {
          const validate = await this.callTool('validate_element', {
            selector: alertSelector,
            timeout_ms: 500,
            include_tree_after_action: false,
          });
          const present = NetronlineHighlightTest.printContentAsJson(validate, `validate_element[try ${i}]`);
          if (!present) {
            console.log(`✅ Alert likely gone after try ${i}`);
            break;
          }
        } catch {
          console.log(`✅ Alert not found after try ${i}`);
          break;
        }

        // As a fallback, press Enter on the alert window
        try {
          const pressEnter = await this.callTool('press_key', {
            selector: alertSelector,
            key: 'Enter',
          });
          NetronlineHighlightTest.printContentAsJson(pressEnter, `press_key[try ${i}]`);
        } catch {}

        await delay(300);
      }
    }

    // Step 2.7: Refresh page after dismissing
    console.log(`\n🔄 Refreshing page post-dismiss (F5)`);
    const refreshAfter = await this.callTool('press_key_global', { key: 'F5' });
    NetronlineHighlightTest.printContentAsJson(refreshAfter, 'press_key_global');
    await delay(1200);

    // Step 3: Wait for and highlight the Florida link (container-agnostic)
    const floridaSelector = 'role:hyperlink|name:Florida';
    console.log(`\n🕒 Waiting for Florida link: ${floridaSelector}`);
    try {
      const validate = await this.callTool('validate_element', {
        selector: floridaSelector,
        alternative_selectors: 'role:hyperlink|name:contains:Florida,role:listitem|name:Florida >> role:hyperlink',
        timeout_ms: 8000,
        include_tree_after_action: false,
      });
      NetronlineHighlightTest.printContentAsJson(validate, 'validate_element');
    } catch (e) {
      console.log('⚠️ Florida link not immediately found; proceeding to highlight with alternatives');
    }

    console.log(`\n🎯 Highlighting selector: ${floridaSelector}`);
    const highlightContent = await this.callTool('highlight_element', {
      selector: floridaSelector,
      alternative_selectors: 'role:hyperlink|name:contains:Florida,role:listitem|name:Florida >> role:hyperlink',
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


