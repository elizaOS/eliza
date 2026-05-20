#!/usr/bin/env bun
/**
 * Generate docs/skills.md or a full Agent Skills package from A2A and MCP source definitions.
 *
 * WHY: We expose A2A and MCP; agents need an up-to-date reference. Hand-maintained docs drift.
 * Generating from the same sources the runtime uses (agent card, executor switch, MCP tool list)
 * keeps published skills and in-repo docs in sync with the API.
 *
 * Reads:
 *   - packages/a2a/src/babylon-agent-card.ts (skills)
 *   - packages/a2a/src/executors/babylon-executor.ts (A2A operation names)
 *   - packages/mcp/src/server/mcp-server.ts (MCP tools)
 *
 * Usage:
 *   bun run scripts/generate-skills-md.ts
 *     → writes docs/skills.md (markdown only)
 *   bun run scripts/generate-skills-md.ts --output path/skills.md
 *     → writes markdown to path
 *   bun run scripts/generate-skills-md.ts --package
 *     → writes a full Agent Skills package to skills/babylon/ (SKILL.md + claw.json)
 *   bun run scripts/generate-skills-md.ts --package --output my-skill-dir
 *     → writes package to my-skill-dir/babylon/
 *
 * Agent Skills format (agentskills.io):
 *   - Skill = directory with SKILL.md. Required frontmatter: name (match dir, lowercase, hyphens), description (≤1024 chars).
 *   - Optional: license, compatibility, metadata (author, version, etc.).
 *   - See https://agentskills.io/specification
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const A2A_AGENT_CARD = join(ROOT, 'packages/a2a/src/babylon-agent-card.ts');
const A2A_EXECUTOR = join(
  ROOT,
  'packages/a2a/src/executors/babylon-executor.ts'
);
const MCP_SERVER = join(ROOT, 'packages/mcp/src/server/mcp-server.ts');
const DEFAULT_OUTPUT = join(ROOT, 'docs/skills.md');

// --- Parse A2A agent card: extract skills (id, name, description, tags, examples) ---
// WHY: Agent card is the source of truth for skill names and descriptions; we avoid duplicating them.
export function parseAgentCardSkills(content: string): Array<{
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}> {
  const skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples: string[];
  }> = [];
  const skillsStart = content.indexOf('skills: [');
  if (skillsStart === -1) return skills;
  const block = content.slice(skillsStart);

  const idPattern = /id:\s*'([^']+)'/g;
  const indices: { id: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = idPattern.exec(block)) !== null)
    indices.push({ id: m[1], start: m.index });
  const blocks: { id: string; raw: string }[] = [];
  for (let i = 0; i < indices.length; i++) {
    // Find the end of this skill block: either the start of next skill or end of skills array
    let end =
      i + 1 < indices.length ? indices[i + 1].start : block.indexOf('\n  ],');
    // Handle case where the closing array pattern isn't found
    if (end === -1) {
      end = block.indexOf('\n];'); // Try alternate closing pattern
      if (end === -1) {
        end = block.length; // Fallback to end of string if no closing pattern found
      }
    }
    const raw = block.slice(indices[i].start, end).trim();
    blocks.push({ id: indices[i].id, raw });
  }

  const nameRe = /name:\s*'([^']+)'/;
  const descRe = /description:\s*\n\s*'((?:[^'\\]|\\.)*)'/;
  const tagsRe = /tags:\s*\[([^\]]+)\]/;
  const examplesRe = /examples:\s*\[([\s\S]*?)\],\s*(?:inputModes|outputModes)/;

  for (const { id, raw: blk } of blocks) {
    const name = nameRe.exec(blk)?.[1] ?? '';
    const description = descRe.exec(blk)?.[1]?.replace(/\\'/g, "'") ?? '';
    const tagsMatch = tagsRe.exec(blk)?.[1];
    const tags = tagsMatch
      ? tagsMatch.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
      : [];
    const examplesMatch = examplesRe.exec(blk)?.[1];
    const examples = examplesMatch
      ? examplesMatch
          .split(/,\s*\n/)
          .map((s) =>
            s
              .trim()
              .replace(/^\s*'|'\s*$/g, '')
              .replace(/\\'/g, "'")
          )
          .filter(Boolean)
      : [];
    skills.push({ id, name, description, tags, examples });
  }
  return skills;
}

// --- Parse A2A executor: extract all case 'operation': ---
// WHY: Executor switch is the single list of supported operations; regex keeps generator in sync without importing runtime.
export function parseExecutorOperations(content: string): string[] {
  const ops: string[] = [];
  const re = /case\s+'([^']+)':/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== 'default') ops.push(m[1]);
  }
  return [...new Set(ops)].sort();
}

// --- Group A2A operations by prefix (social., markets., etc.) ---
function groupOperationsByPrefix(ops: string[]): Map<string, string[]> {
  const byPrefix = new Map<string, string[]>();
  for (const op of ops) {
    const dot = op.indexOf('.');
    const prefix = dot > 0 ? op.slice(0, dot) : 'other';
    const list = byPrefix.get(prefix) ?? [];
    list.push(op);
    byPrefix.set(prefix, list);
  }
  return byPrefix;
}

// --- Map each A2A operation to exactly one skill id (for the skills table) ---
// WHY: Agent card has 12 skills but executor has 76 ops; we map ops to skills so the table is readable and accurate.
function getOperationsForSkill(
  skillId: string,
  operations: string[]
): string[] {
  const escrowOps = new Set([
    'moderation.create_escrow_payment',
    'moderation.verify_escrow_payment',
    'moderation.refund_escrow_payment',
    'moderation.list_escrow_payments',
    'moderation.appeal_ban_with_escrow',
  ]);
  const perpOps = new Set([
    'markets.list_perpetuals',
    'markets.open_position',
    'markets.close_position',
  ]);
  const predMarketOps = new Set([
    'markets.list_prediction',
    'markets.buy_shares',
    'markets.sell_shares',
    'markets.get_trades',
    'markets.get_trade_history',
    'markets.get_market_data',
    'markets.get_market_prices',
  ]);
  const moderationOnlyOps = new Set([
    'moderation.block_user',
    'moderation.unblock_user',
    'moderation.mute_user',
    'moderation.unmute_user',
    'moderation.report_user',
    'moderation.report_post',
    'moderation.get_blocks',
    'moderation.get_mutes',
    'moderation.check_block_status',
    'moderation.check_mute_status',
    'moderation.appeal_ban',
  ]);

  const skillToFilter: Record<string, (op: string) => boolean> = {
    'social-feed': (op) => op.startsWith('social.'),
    'prediction-markets': (op) => predMarketOps.has(op),
    'perpetual-futures': (op) => perpOps.has(op),
    'user-social-graph': (op) => op.startsWith('users.'),
    'messaging-chats': (op) => op.startsWith('messaging.'),
    notifications: (op) => op.startsWith('notifications.'),
    'stats-discovery': (op) => op.startsWith('stats.'),
    'portfolio-balance': (op) =>
      op.startsWith('portfolio.') || op.startsWith('points.'),
    moderation: (op) => moderationOnlyOps.has(op),
    'moderation-escrow': (op) => escrowOps.has(op),
    favorites: (op) => op.startsWith('favorites.'),
    payments: (op) => op.startsWith('payments.'),
  };
  const pred = skillToFilter[skillId];
  if (!pred) return [];
  return operations.filter(pred).sort();
}

// --- Parse MCP server: extract tool name + description ---
// WHY: MCP tool list is the source of truth; parsing the server file avoids importing @babylon/mcp (and its heavy deps) in this script.
export function parseMCPTools(
  content: string
): Array<{ name: string; description: string }> {
  const tools: Array<{ name: string; description: string }> = [];
  const toolsStart = content.indexOf('return [');
  if (toolsStart === -1) return tools;
  const slice = content.slice(toolsStart);
  const re =
    /{\s*name:\s*'([^']+)',\s*description:\s*(?:\n\s*'((?:[^'\\]|\\.)*)'|'([^']+)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    const desc = (m[2] ?? m[3] ?? '')
      .replace(/\\'/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    tools.push({ name: m[1], description: desc });
  }
  return tools;
}

// --- Build markdown ---
// WHY: One body is reused for docs/skills.md and for SKILL.md (package); frontmatter is added only in package mode.
export function generateSkillsMarkdown(
  skills: ReturnType<typeof parseAgentCardSkills>,
  operations: string[],
  byPrefix: Map<string, string[]>,
  mcpTools: Array<{ name: string; description: string }>,
  opts: { skipGeneratedNotice?: boolean } = {}
): string {
  const lines: string[] = [];

  lines.push('# Babylon Agent Skills');
  lines.push('');
  lines.push(
    'Agent skill reference for [Babylon](https://babylon.market): A2A and MCP endpoints, skills, and operations. Use when configuring agents to interact with Babylon (Cursor, Claude Code, and other [AgentSkills](https://agentskills.io)-compatible tools).'
  );
  if (!opts.skipGeneratedNotice) {
    lines.push('');
    lines.push(
      '**This file is auto-generated.** Run `bun run skills:generate` to regenerate after modifying A2A skills, executor operations, or MCP tools.'
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Base URLs');
  lines.push('');
  lines.push('| Environment | Base URL |');
  lines.push('|-------------|---------|');
  lines.push('| Production | `https://babylon.market` |');
  lines.push('| Local | `http://localhost:3000` |');
  lines.push('');
  lines.push('Use `{baseUrl}` below as the appropriate base.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Authentication');
  lines.push('');
  lines.push('- **Header:** `X-Babylon-Api-Key: <key>`');
  lines.push(
    '- **Keys:** Server key (`BABYLON_A2A_API_KEY` or `BABYLON_API_KEY`) or per-user API keys.'
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## A2A Protocol');
  lines.push('');
  lines.push('JSON-RPC 2.0 over HTTP.');
  lines.push('');
  lines.push('### Endpoints');
  lines.push('');
  lines.push('| Method | URL | Description |');
  lines.push('|--------|-----|-------------|');
  lines.push(
    '| **GET** | `{baseUrl}/api/a2a` | Service info and Babylon agent card. |'
  );
  lines.push(
    '| **POST** | `{baseUrl}/api/a2a` | Global A2A: message/send, tasks/*. |'
  );
  lines.push(
    '| **GET** | `{baseUrl}/api/agents/{agentId}/.well-known/agent-card` | Per-agent public agent card. |'
  );
  lines.push(
    '| **GET** | `{baseUrl}/api/agents/{agentId}/a2a` | Per-agent A2A capabilities. |'
  );
  lines.push(
    '| **POST** | `{baseUrl}/api/agents/{agentId}/a2a` | Per-agent A2A (same methods). |'
  );
  lines.push('');
  lines.push('### A2A skills and operations');
  lines.push('');
  lines.push(
    "Operations are sent inside `message/send` with a message part: `{ kind: 'data', data: { operation: '<operation>', params: { ... } } }`."
  );
  lines.push('');
  lines.push('| Skill ID | Name | Operations |');
  lines.push('|----------|------|------------|');

  for (const skill of skills) {
    const ops = getOperationsForSkill(skill.id, operations);
    lines.push(
      `| **${skill.id}** | **${skill.name}** | ${ops.length ? ops.join(', ') : '—'} |`
    );
  }

  lines.push('');
  lines.push('### All A2A operations (by prefix)');
  lines.push('');
  const prefixes = [...byPrefix.keys()].sort();
  for (const p of prefixes) {
    const list = byPrefix.get(p) ?? [];
    lines.push(`- **${p}.** ${list.join(', ')}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## MCP Protocol');
  lines.push('');
  lines.push('| Method | URL | Description |');
  lines.push('|--------|-----|-------------|');
  lines.push(
    '| **GET** | `{baseUrl}/api/mcp` | Server info and capabilities. |'
  );
  lines.push(
    '| **POST** | `{baseUrl}/api/mcp` | JSON-RPC: `tools/list`, `tools/call`. |'
  );
  lines.push('');
  lines.push('### MCP tools');
  lines.push('');
  lines.push('| Tool | Description |');
  lines.push('|------|-------------|');
  for (const t of mcpTools) {
    const desc =
      t.description.length > 80
        ? t.description.slice(0, 77) + '...'
        : t.description;
    lines.push(`| \`${t.name}\` | ${desc} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Generated from `packages/a2a` and `packages/mcp`.*');
  lines.push('');

  return lines.join('\n');
}

const SKILL_NAME = 'babylon';
const SKILL_DESCRIPTION =
  'Interact with Babylon (babylon.market): A2A and MCP endpoints for prediction markets, perpetuals, social feed, messaging, portfolio, and more. Use when the user wants to trade, post, chat, or query Babylon via API key.';

function buildSkillMdFrontmatter(): string {
  return `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
license: MIT
compatibility: Requires network. Use with agents that support MCP or A2A (Cursor, Claude Code, etc.).
metadata:
  author: babylon
  version: "1.0"
  openclaw:
    homepage: "https://babylon.market"
    requires:
      env: ["BABYLON_API_KEY", "BABYLON_A2A_API_KEY"]
    primaryEnv: "BABYLON_A2A_API_KEY"
---
`;
}

function buildClawJson(): string {
  return (
    JSON.stringify(
      {
        name: SKILL_NAME,
        version: '1.0.0',
        description: SKILL_DESCRIPTION,
        author: 'babylon',
        license: 'MIT',
        permissions: ['network'],
        entry: 'SKILL.md',
        tags: [
          'babylon',
          'trading',
          'prediction-markets',
          'a2a',
          'mcp',
          'social',
        ],
        models: ['claude-*', 'gpt-*', 'gemini-*'],
        minOpenClawVersion: '0.8.0',
      },
      null,
      2
    ) + '\n'
  );
}

function main() {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--output');
  const packageMode = args.includes('--package');
  const outputPath =
    outArg !== -1 && args[outArg + 1]
      ? args[outArg + 1]
      : packageMode
        ? join(ROOT, 'skills')
        : DEFAULT_OUTPUT;

  const agentCardContent = readFileSync(A2A_AGENT_CARD, 'utf-8');
  const executorContent = readFileSync(A2A_EXECUTOR, 'utf-8');
  const mcpContent = readFileSync(MCP_SERVER, 'utf-8');

  const skills = parseAgentCardSkills(agentCardContent);
  const operations = parseExecutorOperations(executorContent);
  const byPrefix = groupOperationsByPrefix(operations);
  const mcpTools = parseMCPTools(mcpContent);

  // Validate expected minimum counts
  if (skills.length === 0) {
    console.error('Warning: No skills found in agent card - verify format');
    process.exit(1);
  }

  const mdBody = generateSkillsMarkdown(
    skills,
    operations,
    byPrefix,
    mcpTools,
    {
      skipGeneratedNotice: packageMode,
    }
  );

  if (packageMode) {
    const skillDir = join(outputPath, SKILL_NAME);
    mkdirSync(skillDir, { recursive: true });
    const skillMd = buildSkillMdFrontmatter() + '\n' + mdBody;
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');
    writeFileSync(join(skillDir, 'claw.json'), buildClawJson(), 'utf-8');
    writeFileSync(
      join(skillDir, 'README.md'),
      `# Babylon Agent Skill\n\n${SKILL_DESCRIPTION}\n\n**This package is auto-generated.** Regenerate with \`bun run skills:package\`.\n\nSee SKILL.md for full A2A/MCP reference.\n`,
      'utf-8'
    );
    console.log(
      `Wrote Agent Skills package to ${skillDir}/ (SKILL.md, claw.json, README.md). ${skills.length} A2A skills, ${operations.length} operations, ${mcpTools.length} MCP tools.`
    );
  } else {
    const outDir = dirname(outputPath);
    if (outDir !== '.') mkdirSync(outDir, { recursive: true });
    writeFileSync(outputPath, mdBody, 'utf-8');
    console.log(
      `Wrote ${outputPath} (${skills.length} A2A skills, ${operations.length} operations, ${mcpTools.length} MCP tools).`
    );
  }
}

if (import.meta.main) {
  main();
}
