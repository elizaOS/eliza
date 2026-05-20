#!/usr/bin/env bun

/**
 * Training Data Quality Visualization
 *
 * Generates a self-contained HTML report with SVG charts showing
 * training data quality metrics. Opens in browser.
 *
 * Usage:
 *   bun run report:training-viz                   # Generate and print path
 *   bun run report:training-viz -- --open         # Generate and open in browser
 *   bun run report:training-viz -- --days 30      # 30-day analysis
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  db,
  desc,
  gte,
  npcTrades,
  posts,
  questions,
  worldEvents,
} from '@feed/db';

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '7' },
    open: { type: 'boolean', default: false },
  },
  strict: true,
});

const days = Number.parseInt(args.days || '7', 10);
const shouldOpen = args.open ?? false;
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// ── Fetch data ────────────────────────────────────────────────────────
const [allPosts, allTrades, allEvents, allQuestions] = await Promise.all([
  db
    .select()
    .from(posts)
    .where(gte(posts.createdAt, since))
    .orderBy(desc(posts.createdAt)),
  db
    .select()
    .from(npcTrades)
    .where(gte(npcTrades.executedAt, since))
    .orderBy(desc(npcTrades.executedAt)),
  db
    .select()
    .from(worldEvents)
    .where(gte(worldEvents.timestamp, since))
    .orderBy(desc(worldEvents.timestamp)),
  db.select().from(questions).orderBy(desc(questions.createdAt)),
]);

const npcPosts = allPosts.filter((p) => p.type !== 'article');

// ── Compute metrics ───────────────────────────────────────────────────

// Entity frequency
const entityCounts = new Map<string, number>();
for (const p of npcPosts) {
  entityCounts.set(p.authorId, (entityCounts.get(p.authorId) || 0) + 1);
}
const sortedEntities = [...entityCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

// Post length distribution
const postLengths = npcPosts.map((p) => p.content.length);
const lengthBuckets = new Map<string, number>();
for (const len of postLengths) {
  const bucket = `${Math.floor(len / 20) * 20}-${Math.floor(len / 20) * 20 + 19}`;
  lengthBuckets.set(bucket, (lengthBuckets.get(bucket) || 0) + 1);
}
const sortedLengthBuckets = [...lengthBuckets.entries()].sort((a, b) => {
  const aStart = Number.parseInt(a[0].split('-')[0]!);
  const bStart = Number.parseInt(b[0].split('-')[0]!);
  return aStart - bStart;
});

// Trade action distribution
const actionCounts = new Map<string, number>();
for (const t of allTrades) {
  actionCounts.set(t.action, (actionCounts.get(t.action) || 0) + 1);
}

// Event type distribution
const eventTypeCounts = new Map<string, number>();
for (const e of allEvents) {
  eventTypeCounts.set(e.eventType, (eventTypeCounts.get(e.eventType) || 0) + 1);
}

// Sentence type distribution
let questionCount = 0;
let exclamationCount = 0;
let statementCount = 0;
for (const p of npcPosts) {
  const c = p.content.trim();
  if (c.endsWith('?')) questionCount++;
  else if (c.endsWith('!')) exclamationCount++;
  else statementCount++;
}

// Posts per actor (for activity histogram)
const postsPerActor = new Map<string, number>();
for (const p of npcPosts) {
  postsPerActor.set(p.authorId, (postsPerActor.get(p.authorId) || 0) + 1);
}
const activityBuckets = new Map<number, number>();
for (const count of postsPerActor.values()) {
  activityBuckets.set(count, (activityBuckets.get(count) || 0) + 1);
}

// Caps rate per actor (top 10 by post count)
const capsRates: Array<{ actor: string; rate: number; posts: number }> = [];
for (const [actor, count] of [...postsPerActor.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)) {
  const actorPosts = npcPosts.filter((p) => p.authorId === actor);
  const totalChars = actorPosts.reduce((s, p) => s + p.content.length, 0);
  const upperChars = actorPosts.reduce(
    (s, p) => s + [...p.content].filter((c) => c >= 'A' && c <= 'Z').length,
    0
  );
  capsRates.push({
    actor,
    rate: totalChars > 0 ? upperChars / totalChars : 0,
    posts: count,
  });
}

// Posts per hour (temporal)
const postsPerHour = new Map<number, number>();
for (let h = 0; h < 24; h++) postsPerHour.set(h, 0);
for (const p of npcPosts) {
  const hour = new Date(p.createdAt).getHours();
  postsPerHour.set(hour, (postsPerHour.get(hour) || 0) + 1);
}

// ── SVG chart helpers ─────────────────────────────────────────────────

function barChart(
  data: Array<{ label: string; value: number }>,
  opts: {
    width?: number;
    height?: number;
    barColor?: string;
    title?: string;
    maxLabelLen?: number;
  } = {}
): string {
  const {
    width = 600,
    height = 300,
    barColor = '#4f46e5',
    title = '',
    maxLabelLen = 20,
  } = opts;
  if (data.length === 0) return `<p>No data</p>`;
  const maxVal = Math.max(...data.map((d) => d.value));
  const barWidth = Math.max(8, Math.min(30, (width - 60) / data.length - 2));
  const chartHeight = height - 60;

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="font-family:monospace;font-size:10px">`;
  if (title)
    svg += `<text x="${width / 2}" y="16" text-anchor="middle" font-size="13" font-weight="bold">${title}</text>`;

  const startY = title ? 30 : 10;
  // Bars
  for (let i = 0; i < data.length; i++) {
    const d = data[i]!;
    const barH = maxVal > 0 ? (d.value / maxVal) * (chartHeight - 20) : 0;
    const x = 50 + i * (barWidth + 2);
    const y = startY + chartHeight - 20 - barH;
    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${barColor}" rx="2"><title>${d.label}: ${d.value}</title></rect>`;
    // Value label
    svg += `<text x="${x + barWidth / 2}" y="${y - 3}" text-anchor="middle" font-size="9">${d.value}</text>`;
    // X label (rotated)
    const label =
      d.label.length > maxLabelLen
        ? d.label.substring(0, maxLabelLen) + '..'
        : d.label;
    svg += `<text x="${x + barWidth / 2}" y="${startY + chartHeight - 5}" text-anchor="end" transform="rotate(-45 ${x + barWidth / 2} ${startY + chartHeight - 5})" font-size="9">${label}</text>`;
  }
  svg += '</svg>';
  return svg;
}

function pieChart(
  data: Array<{ label: string; value: number }>,
  opts: { width?: number; height?: number; title?: string } = {}
): string {
  const { width = 300, height = 300, title = '' } = opts;
  if (data.length === 0) return '<p>No data</p>';
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return '<p>No data</p>';
  const cx = width / 2;
  const cy = height / 2 + (title ? 10 : 0);
  const r = Math.min(cx, cy) - 50;
  const colors = [
    '#4f46e5',
    '#059669',
    '#d97706',
    '#dc2626',
    '#7c3aed',
    '#0891b2',
    '#be185d',
    '#65a30d',
  ];

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="font-family:monospace;font-size:10px">`;
  if (title)
    svg += `<text x="${cx}" y="16" text-anchor="middle" font-size="13" font-weight="bold">${title}</text>`;

  let angle = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i]!;
    const sliceAngle = (d.value / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle + sliceAngle);
    const y2 = cy + r * Math.sin(angle + sliceAngle);
    const largeArc = sliceAngle > Math.PI ? 1 : 0;
    const color = colors[i % colors.length]!;

    svg += `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${color}" stroke="white" stroke-width="1"><title>${d.label}: ${d.value} (${((d.value / total) * 100).toFixed(0)}%)</title></path>`;

    // Legend
    const lx = width - 110;
    const ly = 30 + i * 16;
    svg += `<rect x="${lx}" y="${ly}" width="10" height="10" fill="${color}"/>`;
    svg += `<text x="${lx + 14}" y="${ly + 9}" font-size="9">${d.label} (${((d.value / total) * 100).toFixed(0)}%)</text>`;

    angle += sliceAngle;
  }
  svg += '</svg>';
  return svg;
}

function histogram(
  data: Array<{ label: string; value: number }>,
  opts: {
    width?: number;
    height?: number;
    title?: string;
    barColor?: string;
  } = {}
): string {
  return barChart(data, { ...opts, barColor: opts.barColor || '#059669' });
}

// ── Generate HTML ─────────────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html>
<head>
  <title>Training Data Quality Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #0f0f0f; color: #e0e0e0; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 10px; }
    h2 { color: #8b8bff; margin-top: 40px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; }
    .card h3 { margin-top: 0; color: #ccc; }
    .metric { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #222; }
    .metric .label { color: #888; }
    .metric .value { font-weight: bold; }
    .ok { color: #22c55e; }
    .warn { color: #eab308; }
    .crit { color: #ef4444; }
    .summary { background: #1a1a2e; border: 1px solid #4f46e5; border-radius: 8px; padding: 16px; margin: 20px 0; }
    svg { background: #111; border-radius: 8px; }
    .chart-row { display: flex; gap: 20px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <h1>Training Data Quality Report</h1>
  <div class="summary">
    <strong>Period:</strong> last ${days} days (since ${since.toISOString().slice(0, 10)}) |
    <strong>Posts:</strong> ${npcPosts.length} NPC, ${allPosts.length - npcPosts.length} articles |
    <strong>Trades:</strong> ${allTrades.length} |
    <strong>Events:</strong> ${allEvents.length} |
    <strong>Questions:</strong> ${allQuestions.length}
  </div>

  <h2>Entity Distribution</h2>
  <div class="chart-row">
    ${barChart(
      sortedEntities.map(([label, value]) => ({ label, value })),
      { title: 'Posts per Actor (Top 20)', width: 700, height: 300 }
    )}
  </div>

  <h2>Post Length Distribution</h2>
  <div class="chart-row">
    ${histogram(
      sortedLengthBuckets.map(([label, value]) => ({ label, value })),
      { title: 'Post Length (chars)', width: 600, height: 250 }
    )}
  </div>

  <h2>Trade Action Distribution</h2>
  <div class="chart-row">
    ${pieChart(
      [...actionCounts.entries()].map(([label, value]) => ({ label, value })),
      { title: 'Trade Actions', width: 350, height: 300 }
    )}
    ${pieChart(
      [
        { label: 'questions', value: questionCount },
        { label: 'exclamations', value: exclamationCount },
        { label: 'statements', value: statementCount },
      ].filter((d) => d.value > 0),
      { title: 'Sentence Types', width: 350, height: 300 }
    )}
  </div>

  <h2>Event Type Distribution</h2>
  <div class="chart-row">
    ${pieChart(
      [...eventTypeCounts.entries()].map(([label, value]) => ({
        label,
        value,
      })),
      { title: 'Event Types', width: 350, height: 300 }
    )}
  </div>

  <h2>Actor Voice Differentiation: Caps Rate</h2>
  <div class="chart-row">
    ${barChart(
      capsRates.map((c) => ({
        label: c.actor,
        value: Math.round(c.rate * 100),
      })),
      {
        title: 'Uppercase Rate % per Actor',
        width: 700,
        height: 280,
        barColor: '#d97706',
      }
    )}
  </div>

  <h2>NPC Activity Distribution</h2>
  <div class="chart-row">
    ${barChart(
      [...activityBuckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([posts, count]) => ({
          label: `${posts} post${posts > 1 ? 's' : ''}`,
          value: count,
        })),
      {
        title: 'NPCs by Post Count',
        width: 400,
        height: 250,
        barColor: '#7c3aed',
      }
    )}
  </div>

  <h2>Temporal: Posts per Hour</h2>
  <div class="chart-row">
    ${barChart(
      [...postsPerHour.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([hour, count]) => ({ label: `${hour}:00`, value: count })),
      {
        title: 'Posts by Hour of Day',
        width: 700,
        height: 250,
        barColor: '#0891b2',
      }
    )}
  </div>

  <footer style="margin-top: 40px; padding-top: 10px; border-top: 1px solid #333; color: #666; font-size: 12px;">
    Generated ${new Date().toISOString()} | Feed Training Data Quality Tool
  </footer>
</body>
</html>`;

const outPath = join(process.cwd(), 'training-data-report.html');
writeFileSync(outPath, html);
console.log(`Report written to: ${outPath}`);

if (shouldOpen) {
  const { $ } = await import('bun');
  await $`open ${outPath} || xdg-open ${outPath} || echo "Open ${outPath} in your browser"`.nothrow();
}

process.exit(0);
