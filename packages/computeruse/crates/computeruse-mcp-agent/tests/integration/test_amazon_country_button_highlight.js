#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer(port) {
  const candidates = [
    path.join(__dirname, '../../target/release/computeruse-mcp-agent.exe'),
    path.join(__dirname, '../../target/release/computeruse-mcp-agent'),
    'target/release/computeruse-mcp-agent.exe',
    'target/release/computeruse-mcp-agent',
  ];
  let bin = null;
  for (const p of candidates) if (fs.existsSync(p)) { bin = p; break; }
  if (!bin) throw new Error('computeruse-mcp-agent binary not found (build release first).');

  const proc = spawn(bin, ['--transport', 'http', '--port', String(port)], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, RUST_LOG: 'info' },
  });

  // wait for health
  const health = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(health, { method: 'GET', signal: AbortSignal.timeout(500) });
      if (res.ok) return proc;
    } catch {}
    await delay(200);
  }
  proc.kill('SIGKILL');
  throw new Error('MCP server failed to become healthy');
}

async function connect(port) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: 'amazon-country-button-highlight', version: '1.0.0' }, { capabilities: { tools: {} } });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args || {} });
}

async function main() {
  const port = 3013;
  const server = await startServer(port);
  const { client, transport } = await connect(port);

  try {
    await callTool(client, 'navigate_browser', {
      url: 'https://www.amazon.com/',
      include_tree_after_action: false
    });

    // Candidate selectors for the country/region button (icp-button)
    const candidates = [
      "role:Button|name:contains:Choose a country",
      "role:Button|name:contains:country/region",
      "role:Button|name:contains:country",
      "role:Pane|name:contains:Amazon >> role:Button|name:contains:Choose a country",
      "role:Pane|name:contains:Amazon >> role:Button|name:contains:country/region"
    ];

    let success = false;
    for (const selector of candidates) {
      try {
        const res = await callTool(client, 'highlight_element', {
          selector,
          color: 0x00FF00,
          duration_ms: 2500,
          text: 'Country/Region',
          text_position: 'TopRight',
          include_tree_after_action: false,
          include_element_info: false,
          timeout_ms: 20000
        });
        console.log('highlight_element OK with selector:', selector);
        console.log(res.content?.[0]?.text ?? '');
        success = true;
        break;
      } catch (e) {
        // try next
      }
    }

    if (!success) throw new Error('Failed to highlight Amazon country/region button with all selector candidates.');
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
    try {
      server.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      server.kill('SIGKILL');
    } catch {}
  }
}

main().catch(err => { console.error('Script error:', err); process.exit(1); });


