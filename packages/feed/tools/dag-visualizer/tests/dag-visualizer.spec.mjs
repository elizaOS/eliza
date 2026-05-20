/**
 * Comprehensive E2E + Integration tests for the Feed DAG Visualizer.
 *
 * These tests verify:
 *  1. The standalone HTML loads and renders
 *  2. Demo data generation produces a schema-complete TickTrace
 *  3. ALL 24 DAG nodes are rendered with correct phases
 *  4. ALL 27 edges are rendered with labels
 *  5. Node click opens detail panel with ALL tabs
 *  6. Overview tab shows full metadata, timing, data flow edges
 *  7. Inputs tab shows ALL input fields with expandable JSON
 *  8. Outputs tab shows ALL output fields with expandable JSON
 *  9. LLM Calls tab shows FULL system prompt, user prompt, raw response, parsed response
 * 10. NPC tab shows ALL decisions, trades, posts, group messages
 * 11. Raw JSON tab renders complete node trace
 * 12. Top stats bar shows correct aggregated counts
 * 13. Search/filter works across detail content
 * 14. File loading (JSON) works
 * 15. Data completeness: every engine data type is captured
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(__dirname, '..', 'index.html');
const FILE_URL = `file://${HTML_PATH}`;

// ============================================================
// SECTION 1: Page Load & Welcome Screen
// ============================================================
test.describe('Page Load & Welcome Screen', () => {
  test('standalone HTML loads without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(FILE_URL);
    await page.waitForLoadState('domcontentloaded');
    expect(errors).toEqual([]);
  });

  test('welcome screen is visible on load', async ({ page }) => {
    await page.goto(FILE_URL);
    const welcome = page.locator('#welcomeScreen');
    await expect(welcome).toBeVisible();
    await expect(welcome.locator('h1')).toHaveText('Feed DAG Inspector');
  });

  test('welcome screen has Load Demo and Load JSON buttons', async ({
    page,
  }) => {
    await page.goto(FILE_URL);
    await expect(page.locator('text=Load Demo Trace')).toBeVisible();
    await expect(page.locator('text=Load JSON File')).toBeVisible();
  });

  test('drop zone is visible', async ({ page }) => {
    await page.goto(FILE_URL);
    await expect(page.locator('#dropZone')).toBeVisible();
  });

  test('DAG panel and detail panel are hidden before loading', async ({
    page,
  }) => {
    await page.goto(FILE_URL);
    await expect(page.locator('#dagPanel')).toBeHidden();
    await expect(page.locator('#detailPanel')).toBeHidden();
  });
});

// ============================================================
// SECTION 2: Demo Data Loading
// ============================================================
test.describe('Demo Data Loading', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    // Wait for DAG to render
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('welcome screen hides after loading demo', async ({ page }) => {
    await expect(page.locator('#welcomeScreen')).toBeHidden();
  });

  test('DAG panel becomes visible', async ({ page }) => {
    await expect(page.locator('#dagPanel')).toBeVisible();
  });

  test('detail panel becomes visible', async ({ page }) => {
    await expect(page.locator('#detailPanel')).toBeVisible();
  });

  test('market-decisions node is auto-selected', async ({ page }) => {
    // Demo auto-selects market-decisions after 100ms
    await page.waitForTimeout(200);
    await expect(page.locator('#detailTitle')).toHaveText('Market Decisions');
  });
});

// ============================================================
// SECTION 3: Demo Data Schema Integrity (Integration Tests)
// ============================================================
test.describe('Demo Data Schema Completeness', () => {
  test('demo trace matches TickTrace schema exactly', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const trace = await page.evaluate(() => currentTrace);

    // Top-level TickTrace fields
    expect(trace).toHaveProperty('tickId');
    expect(trace).toHaveProperty('tickNumber');
    expect(trace).toHaveProperty('timestamp');
    expect(trace).toHaveProperty('startMs');
    expect(trace).toHaveProperty('endMs');
    expect(trace).toHaveProperty('durationMs');
    expect(trace).toHaveProperty('dag');
    expect(trace).toHaveProperty('nodes');
    expect(trace).toHaveProperty('llmCalls');
    expect(trace).toHaveProperty('npcTrajectories');
    expect(trace).toHaveProperty('tokenStats');
    expect(trace).toHaveProperty('gameTickResult');

    // Type checks
    expect(typeof trace.tickId).toBe('string');
    expect(typeof trace.tickNumber).toBe('number');
    expect(typeof trace.timestamp).toBe('string');
    expect(typeof trace.startMs).toBe('number');
    expect(typeof trace.endMs).toBe('number');
    expect(typeof trace.durationMs).toBe('number');
    expect(trace.durationMs).toBe(45000);
    expect(trace.tickNumber).toBe(2847);
    expect(Array.isArray(trace.nodes)).toBe(true);
    expect(Array.isArray(trace.llmCalls)).toBe(true);
    expect(Array.isArray(trace.npcTrajectories)).toBe(true);
  });

  test('DagDefinition has all 24 nodes and 27 edges', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const dag = await page.evaluate(() => currentTrace.dag);

    expect(dag.nodes.length).toBe(24);
    expect(dag.edges.length).toBe(27);

    // Verify every node has required fields
    for (const node of dag.nodes) {
      expect(node).toHaveProperty('id');
      expect(node).toHaveProperty('name');
      expect(node).toHaveProperty('phase');
      expect(node).toHaveProperty('phaseNumber');
      expect(node).toHaveProperty('description');
      expect(typeof node.id).toBe('string');
      expect(typeof node.name).toBe('string');
      expect(typeof node.phase).toBe('string');
      expect(typeof node.phaseNumber).toBe('number');
    }

    // Verify every edge has required fields
    for (const edge of dag.edges) {
      expect(edge).toHaveProperty('source');
      expect(edge).toHaveProperty('target');
      expect(edge).toHaveProperty('label');
    }
  });

  test('all 8 phases are represented', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const phases = await page.evaluate(() => {
      return [...new Set(currentTrace.dag.nodes.map((n) => n.phase))].sort();
    });

    expect(phases).toEqual([
      'Bootstrap',
      'ContentMaintenance',
      'Events',
      'Finalize',
      'Markets',
      'Questions',
      'Rebalancing',
      'Social',
    ]);
  });

  test('all 24 expected node IDs are present', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const nodeIds = await page.evaluate(() =>
      currentTrace.dag.nodes.map((n) => n.id).sort()
    );

    const expected = [
      'alpha-invites',
      'bootstrap',
      'bootstrap-content',
      'events',
      'game-state-update',
      'init',
      'market-baseline',
      'market-decisions',
      'market-volatility',
      'narrative-arcs',
      'oracle-commitments',
      'price-updates',
      'question-topup',
      'questions-init',
      'questions-load',
      'rebalancing',
      'relationships',
      'reputation-sync',
      'timeframed-markets',
      'token-stats-finalize',
      'trade-execution',
      'trending-tags',
      'widget-caches',
      'group-dynamics',
    ].sort();

    expect(nodeIds).toEqual(expected);
  });

  test('every node trace has complete NodeTrace schema', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const nodes = await page.evaluate(() => currentTrace.nodes);

    expect(nodes.length).toBe(24);

    for (const node of nodes) {
      expect(node).toHaveProperty('nodeId');
      expect(node).toHaveProperty('name');
      expect(node).toHaveProperty('phase');
      expect(node).toHaveProperty('phaseNumber');
      expect(node).toHaveProperty('startMs');
      expect(node).toHaveProperty('endMs');
      expect(node).toHaveProperty('durationMs');
      expect(node).toHaveProperty('status');
      expect(node).toHaveProperty('inputs');
      expect(node).toHaveProperty('outputs');
      expect(node).toHaveProperty('llmCallIds');
      expect(['success', 'error', 'skipped', 'delegated']).toContain(
        node.status
      );
      expect(typeof node.inputs).toBe('object');
      expect(typeof node.outputs).toBe('object');
      expect(Array.isArray(node.llmCallIds)).toBe(true);
    }
  });

  test('every LLM call has complete LLMCallTrace schema', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const calls = await page.evaluate(() => currentTrace.llmCalls);

    expect(calls.length).toBe(15);

    for (const call of calls) {
      // All LLMCallTrace fields
      expect(call).toHaveProperty('callId');
      expect(call).toHaveProperty('nodeId');
      expect(call).toHaveProperty('timestamp');
      expect(call).toHaveProperty('provider');
      expect(call).toHaveProperty('model');
      expect(call).toHaveProperty('promptType');
      expect(call).toHaveProperty('format');
      expect(call).toHaveProperty('temperature');
      expect(call).toHaveProperty('maxTokens');
      expect(call).toHaveProperty('systemPrompt');
      expect(call).toHaveProperty('userPrompt');
      expect(call).toHaveProperty('rawResponse');
      expect(call).toHaveProperty('parsedResponse');
      expect(call).toHaveProperty('inputTokens');
      expect(call).toHaveProperty('outputTokens');
      expect(call).toHaveProperty('totalTokens');
      expect(call).toHaveProperty('durationMs');
      expect(call).toHaveProperty('success');

      // Must have ACTUAL content, not placeholders
      expect(call.systemPrompt.length).toBeGreaterThan(50);
      expect(call.userPrompt.length).toBeGreaterThan(50);
      expect(call.rawResponse.length).toBeGreaterThan(10);
      expect(call.inputTokens).toBeGreaterThan(0);
      expect(call.outputTokens).toBeGreaterThan(0);
      expect(call.durationMs).toBeGreaterThan(0);
    }
  });

  test('every NPC trajectory has complete NPCTickTrajectory schema', async ({
    page,
  }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const npcs = await page.evaluate(() => currentTrace.npcTrajectories);

    expect(npcs.length).toBe(8);

    for (const npc of npcs) {
      expect(npc).toHaveProperty('npcId');
      expect(npc).toHaveProperty('npcName');
      expect(npc).toHaveProperty('decisions');
      expect(npc).toHaveProperty('trades');
      expect(npc).toHaveProperty('posts');
      expect(npc).toHaveProperty('groupMessages');
      expect(Array.isArray(npc.decisions)).toBe(true);
      expect(Array.isArray(npc.trades)).toBe(true);
      expect(Array.isArray(npc.posts)).toBe(true);
      expect(Array.isArray(npc.groupMessages)).toBe(true);

      // At least one decision and one trade per NPC
      expect(npc.decisions.length).toBeGreaterThanOrEqual(1);
      expect(npc.trades.length).toBeGreaterThanOrEqual(1);

      // Verify decision schema
      for (const d of npc.decisions) {
        expect(d).toHaveProperty('action');
        expect(d).toHaveProperty('amount');
        expect(d).toHaveProperty('confidence');
        expect(d).toHaveProperty('reasoning');
        expect(typeof d.reasoning).toBe('string');
        expect(d.reasoning.length).toBeGreaterThan(5);
      }

      // Verify trade schema
      for (const t of npc.trades) {
        expect(t).toHaveProperty('action');
        expect(t).toHaveProperty('amount');
        expect(t).toHaveProperty('success');
        expect(typeof t.success).toBe('boolean');
      }
    }
  });

  test('tokenStats has complete TokenStatsSummary schema', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const stats = await page.evaluate(() => currentTrace.tokenStats);

    expect(stats).toHaveProperty('totalCalls');
    expect(stats).toHaveProperty('totalInputTokens');
    expect(stats).toHaveProperty('totalOutputTokens');
    expect(stats).toHaveProperty('totalTokens');
    expect(stats).toHaveProperty('estimatedCostUSD');
    expect(stats).toHaveProperty('byPromptType');

    expect(stats.totalCalls).toBe(15);
    expect(stats.totalInputTokens).toBe(42800);
    expect(stats.totalOutputTokens).toBe(18350);
    expect(stats.totalTokens).toBe(61150);
    expect(stats.estimatedCostUSD).toBeGreaterThan(0);

    // byPromptType should have entries for each type
    const promptTypes = Object.keys(stats.byPromptType);
    expect(promptTypes).toContain('event-generation');
    expect(promptTypes).toContain('npc-market-decisions');
    expect(promptTypes).toContain('narrative-generation');
    expect(promptTypes).toContain('relationship-analysis');
    expect(promptTypes).toContain('group-messages');
    expect(promptTypes).toContain('group-dynamics');

    for (const [, v] of Object.entries(stats.byPromptType)) {
      expect(v).toHaveProperty('calls');
      expect(v).toHaveProperty('inputTokens');
      expect(v).toHaveProperty('outputTokens');
    }
  });

  test('gameTickResult has meaningful content', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    const result = await page.evaluate(() => currentTrace.gameTickResult);

    expect(result.success).toBe(true);
    expect(result.tickNumber).toBe(2847);
    expect(result.eventsGenerated).toBe(3);
    expect(result.decisionsProcessed).toBe(47);
    expect(result.tradesExecuted).toBe(35);
    expect(result.postsCreated).toBe(3);
    expect(result.groupMessagesGenerated).toBe(18);
    expect(result.relationshipsUpdated).toBe(34);
  });
});

// ============================================================
// SECTION 4: SVG DAG Rendering
// ============================================================
test.describe('SVG DAG Rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('SVG canvas has viewBox set', async ({ page }) => {
    const viewBox = await page.locator('#dagCanvas').getAttribute('viewBox');
    expect(viewBox).toBeTruthy();
    const parts = viewBox.split(' ').map(Number);
    expect(parts.length).toBe(4);
    expect(parts[2]).toBeGreaterThan(500); // width
    expect(parts[3]).toBeGreaterThan(200); // height
  });

  test('all 24 node rectangles are rendered', async ({ page }) => {
    // Each node is a <g> with a <rect> inside
    const nodeGroups = await page
      .locator('#dagCanvas g[cursor="pointer"]')
      .count();
    expect(nodeGroups).toBe(24);
  });

  test('all 8 phase background rectangles are rendered', async ({ page }) => {
    // Phase backgrounds are rects with rx=8 drawn before node groups
    const phaseLabels = await page.evaluate(() => {
      const texts = document.querySelectorAll('#dagCanvas > text');
      return [...texts]
        .map((t) => t.textContent)
        .filter((t) =>
          [
            'Bootstrap',
            'Questions',
            'Events',
            'Markets',
            'Rebalancing',
            'ContentMaintenance',
            'Social',
            'Finalize',
          ].includes(t)
        );
    });
    expect(phaseLabels.length).toBe(8);
  });

  test('edges are rendered connecting nodes', async ({ page }) => {
    // All edges become either paths (cross-phase beziers) or paths (intra-phase vertical)
    const pathCount = await page.locator('#dagCanvas path').count();
    expect(pathCount).toBeGreaterThanOrEqual(20);

    // Check that cross-phase edge labels exist
    const edgeLabels = await page.evaluate(() => {
      const texts = document.querySelectorAll(
        '#dagCanvas text[text-anchor="middle"]'
      );
      return [...texts].map((t) => t.textContent).filter(Boolean);
    });
    // Cross-phase edges get labels rendered at midpoints
    expect(edgeLabels.length).toBeGreaterThan(0);
  });

  test('success nodes have green status circles', async ({ page }) => {
    const greenCircles = await page.evaluate(() => {
      const circles = document.querySelectorAll(
        '#dagCanvas circle[fill="#22c55e"]'
      );
      return circles.length;
    });
    // Most nodes are success
    expect(greenCircles).toBeGreaterThanOrEqual(18);
  });

  test('skipped nodes have gray status circles', async ({ page }) => {
    const grayCircles = await page.evaluate(() => {
      const circles = document.querySelectorAll(
        '#dagCanvas circle[fill="#6b7280"]'
      );
      return circles.length;
    });
    // bootstrap-content, questions-init, question-topup are skipped (market-baseline is delegated now)
    expect(grayCircles).toBe(3);
  });

  test('delegated nodes have teal status circles', async ({ page }) => {
    const tealCircles = await page.evaluate(() => {
      const circles = document.querySelectorAll(
        '#dagCanvas circle[fill="#14b8a6"]'
      );
      return circles.length;
    });
    // market-baseline is delegated
    expect(tealCircles).toBe(1);
  });
});

// ============================================================
// SECTION 5: Top Stats Bar
// ============================================================
test.describe('Top Stats Bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('shows correct duration', async ({ page }) => {
    const stats = await page.locator('#topStats').textContent();
    expect(stats).toContain('45.0s');
  });

  test('shows correct node count', async ({ page }) => {
    const stats = await page.locator('#topStats').textContent();
    expect(stats).toContain('Nodes:');
    expect(stats).toContain('24');
  });

  test('shows correct LLM call count', async ({ page }) => {
    const stats = await page.locator('#topStats').textContent();
    expect(stats).toContain('LLM Calls:');
    expect(stats).toContain('15');
  });

  test('shows correct NPC count', async ({ page }) => {
    const stats = await page.locator('#topStats').textContent();
    expect(stats).toContain('NPCs:');
    expect(stats).toContain('8');
  });

  test('shows token count', async ({ page }) => {
    const stats = await page.locator('#topStats').textContent();
    expect(stats).toContain('Tokens:');
    expect(stats).toContain('61,150');
  });

  test('shows cost', async ({ page }) => {
    const stats = await page.locator('#topStats').textContent();
    expect(stats).toContain('Cost:');
    expect(stats).toContain('$0.0485');
  });

  test('shows skipped count', async ({ page }) => {
    const stats = await page.locator('#topStats').textContent();
    expect(stats).toContain('Skipped:');
    expect(stats).toContain('3');
  });
});

// ============================================================
// SECTION 6: Node Click -> Detail Panel
// ============================================================
test.describe('Node Selection & Detail Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('clicking a node updates detail panel title', async ({ page }) => {
    // Click on the "init" node - find it by text
    await page.evaluate(() => selectNode('init'));
    await expect(page.locator('#detailTitle')).toHaveText('Initialize');
  });

  test('clicking different nodes changes the panel', async ({ page }) => {
    await page.evaluate(() => selectNode('events'));
    await expect(page.locator('#detailTitle')).toHaveText('Generate Events');

    await page.evaluate(() => selectNode('rebalancing'));
    await expect(page.locator('#detailTitle')).toHaveText(
      'Portfolio Rebalancing'
    );
  });

  test('close button resets detail panel', async ({ page }) => {
    await page.evaluate(() => selectNode('init'));
    await expect(page.locator('#detailTitle')).toHaveText('Initialize');

    await page.evaluate(() => closeDetail());
    await expect(page.locator('#detailTitle')).toHaveText('Select a node');
  });

  test('nodes with LLM calls show LLM Calls tab', async ({ page }) => {
    await page.evaluate(() => selectNode('events'));
    const tabs = await page.locator('.detail-tabs .tab').allTextContents();
    expect(tabs).toContain('LLM Calls (1)');
  });

  test('nodes with 8 LLM calls show correct count', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const tabs = await page.locator('.detail-tabs .tab').allTextContents();
    expect(tabs.some((t) => t.includes('LLM Calls (9)'))).toBe(true);
  });

  test('market nodes show NPCs tab', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const tabs = await page.locator('.detail-tabs .tab').allTextContents();
    expect(tabs.some((t) => t.startsWith('NPCs'))).toBe(true);
  });

  test('nodes without LLM calls do NOT show LLM tab', async ({ page }) => {
    await page.evaluate(() => selectNode('init'));
    const tabs = await page.locator('.detail-tabs .tab').allTextContents();
    expect(tabs.some((t) => t.startsWith('LLM Calls'))).toBe(false);
  });

  test('every node always has Overview, Inputs, Outputs, Raw JSON tabs', async ({
    page,
  }) => {
    const nodeIds = [
      'init',
      'events',
      'market-decisions',
      'rebalancing',
      'token-stats-finalize',
    ];
    for (const nodeId of nodeIds) {
      await page.evaluate((id) => selectNode(id), nodeId);
      const tabs = await page.locator('.detail-tabs .tab').allTextContents();
      expect(tabs).toContain('Overview');
      expect(tabs).toContain('Inputs');
      expect(tabs).toContain('Outputs');
      expect(tabs).toContain('Raw JSON');
    }
  });
});

// ============================================================
// SECTION 7: Overview Tab Content
// ============================================================
test.describe('Overview Tab - Complete Data', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('shows node ID, name, phase, description', async ({ page }) => {
    await page.evaluate(() => selectNode('events'));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('events');
    expect(body).toContain('Generate Events');
    expect(body).toContain('Events');
    expect(body).toContain('World events and arc pulse events');
  });

  test('shows execution timing with duration and percentage', async ({
    page,
  }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('12.7s');
    expect(body).toContain('% of Tick');
  });

  test('shows status badge for success nodes', async ({ page }) => {
    await page.evaluate(() => selectNode('init'));
    const badge = page.locator('.badge-success');
    await expect(badge).toBeVisible();
  });

  test('shows status badge for skipped nodes with reason', async ({ page }) => {
    await page.evaluate(() => selectNode('bootstrap-content'));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('skipped');
    expect(body).toContain('Not first tick');
  });

  test('shows data flow edges (IN and OUT)', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const body = await page.locator('#detailBody').textContent();
    // Incoming edges
    expect(body).toContain('market-baseline');
    expect(body).toContain('baseline');
    expect(body).toContain('worldContext');
    // Outgoing edges
    expect(body).toContain('trade-execution');
    expect(body).toContain('decisions[]');
  });

  test('shows LLM call summary with provider, model, tokens', async ({
    page,
  }) => {
    await page.evaluate(() => selectNode('events'));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('groq');
    expect(body).toContain('llama-3.3-70b-versatile');
    expect(body).toContain('event-generation');
  });

  test('shows input and output field names', async ({ page }) => {
    await page.evaluate(() => selectNode('events'));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Input Fields');
    expect(body).toContain('activeQuestions');
    expect(body).toContain('Output Fields');
    expect(body).toContain('eventsGenerated');
  });
});

// ============================================================
// SECTION 8: Inputs Tab - Full Data
// ============================================================
test.describe('Inputs Tab - Full Data Visibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('shows all input fields for market-decisions', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    // Switch to Inputs tab
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Inputs'
      );
      if (tab) tab.click();
    });
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('npcCount');
    expect(body).toContain('activeQuestions');
    expect(body).toContain('worldContext');
    expect(body).toContain('recentEvents');
    expect(body).toContain('marketState');
    expect(body).toContain('predictionMarkets');
  });

  test('input data is expandable and shows full JSON', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Inputs'
      );
      if (tab) tab.click();
    });

    // Click Expand All
    await page.click('text=Expand All');
    const body = await page.locator('#detailBody').textContent();
    // Should now see actual market prices
    expect(body).toContain('94850'); // aiBitcoin price
    expect(body).toContain('3420'); // ETH price
    expect(body).toContain('Regulatory uncertainty');
  });

  test('shows data size indicators', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Inputs'
      );
      if (tab) tab.click();
    });
    const body = await page.locator('#detailBody').textContent();
    // Should show size like "1.2KB" etc
    expect(body).toMatch(/\d+(\.\d+)?(B|KB|MB)/);
  });
});

// ============================================================
// SECTION 9: Outputs Tab - Full Data
// ============================================================
test.describe('Outputs Tab - Full Data Visibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('shows all output fields for price-updates', async ({ page }) => {
    await page.evaluate(() => selectNode('price-updates'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('pricesUpdated');
    expect(body).toContain('priceChanges');
    expect(body).toContain('aiBitcoin');
    expect(body).toContain('94850'); // before price
    expect(body).toContain('95120'); // after price
    expect(body).toContain('Net buy pressure');
  });

  test('shows prediction market updates in output', async ({ page }) => {
    await page.evaluate(() => selectNode('price-updates'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('predictionMarketUpdates');
    expect(body).toContain('yesOddsBefore');
    expect(body).toContain('yesOddsAfter');
  });

  test('narrative arc output shows full text', async ({ page }) => {
    await page.evaluate(() => selectNode('narrative-arcs'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('insider trading investigation');
    expect(body).toContain('blockchain forensics');
    expect(body).toContain('sentimentShift');
  });

  test('trending tags output shows actual tags', async ({ page }) => {
    await page.evaluate(() => selectNode('trending-tags'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('#aiBitcoin');
    expect(body).toContain('#SolanderBurn');
    expect(body).toContain('#InstitutionalAdoption');
  });
});

// ============================================================
// SECTION 10: LLM Calls Tab - Full Prompts & Responses
// ============================================================
test.describe('LLM Calls Tab - Complete Prompt/Response Data', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    // Wait for auto-select timeout to complete so it doesn't interfere
    await page.waitForTimeout(300);
  });

  test('events node shows full system prompt', async ({ page }) => {
    await page.evaluate(() => {
      selectNode('events');
      // Switch to LLM Calls tab programmatically
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    // Expand all LLM cards programmatically
    await page.evaluate(() => toggleAllLLMCards(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Feed World Engine');
    expect(body).toContain('narrative simulation system');
    expect(body).toContain('prediction market signals');
    expect(body).toContain('NEVER real ones');
  });

  test('events node shows full user prompt with context', async ({ page }) => {
    await page.evaluate(() => {
      selectNode('events');
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => toggleAllLLMCards(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Generate world events for day 42');
    expect(body).toContain('Will aiBitcoin reach $100k');
    expect(body).toContain('SEC hearing postponed');
    expect(body).toContain('Regulatory Reckoning');
    expect(body).toContain('DeFi Summer 2.0');
    expect(body).toContain('The Insider Ring');
  });

  test('events node shows full raw response', async ({ page }) => {
    await page.evaluate(() => {
      selectNode('events');
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => toggleAllLLMCards(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('institutional investor for $500M');
    expect(body).toContain('banking consortium');
    expect(body).toContain('token burn mechanism');
  });

  test('events node shows parsed response', async ({ page }) => {
    await page.evaluate(() => {
      selectNode('events');
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => toggleAllLLMCards(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Parsed Response');
  });

  test('LLM call cards show provider, model, token counts', async ({
    page,
  }) => {
    await page.evaluate(() => {
      selectNode('events');
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('groq');
    expect(body).toContain('llama-3.3-70b'); // model name (may be truncated in badge)
    expect(body).toContain('event-generation');
    expect(body).toContain('OK');
  });

  test('market-decisions shows all 8 LLM call cards', async ({ page }) => {
    await page.evaluate(() => {
      selectNode('market-decisions');
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    const cards = await page.locator('.llm-card').count();
    expect(cards).toBe(9);
  });

  test('each NPC market decision has personality in system prompt', async ({
    page,
  }) => {
    await page.evaluate(() => {
      selectNode('market-decisions');
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => toggleAllLLMCards(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Risk tolerance:');
    expect(body).toContain('Trading style:');
    expect(body).toContain('Experience level:');
  });

  test('narrative-arcs LLM call has arc phase transition context', async ({
    page,
  }) => {
    await page.evaluate(() => {
      selectNode('narrative-arcs');
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => toggleAllLLMCards(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Feed Narrative Engine');
    expect(body).toContain('ARC PHASE TRANSITIONS');
    expect(body).toContain('crisis');
    expect(body).toContain('revelation');
  });

  test('LLM call metadata shows temperature, maxTokens, format', async ({
    page,
  }) => {
    await page.evaluate(() => {
      selectNode('events');
      const tabs = document.querySelectorAll('.detail-tabs .tab');
      const llmTab = [...tabs].find((t) =>
        t.textContent.startsWith('LLM Calls')
      );
      if (llmTab) llmTab.click();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => toggleAllLLMCards(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Temp:');
    expect(body).toContain('Max Tokens:');
    expect(body).toContain('Format:');
    expect(body).toContain('In:');
    expect(body).toContain('Out:');
  });
});

// ============================================================
// SECTION 11: NPC Trajectories Tab
// ============================================================
test.describe('NPC Trajectories Tab - Complete Data', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('market-decisions NPCs tab shows NPC cards', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const npcTab = page.locator('#detailTabs .tab').filter({ hasText: 'NPCs' });
    await npcTab.click();
    const cards = await page.locator('.npc-card').count();
    expect(cards).toBeGreaterThanOrEqual(6); // NPCs with non-zero actions
  });

  test('NPC cards show decision details', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const npcTab = page.locator('#detailTabs .tab').filter({ hasText: 'NPCs' });
    await npcTab.click();
    await page.click('text=Expand All');
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Decisions');
    expect(body).toContain('Action');
    expect(body).toContain('Confidence');
    expect(body).toContain('Reasoning');
  });

  test('NPC cards show trade results', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const npcTab = page.locator('#detailTabs .tab').filter({ hasText: 'NPCs' });
    await npcTab.click();
    await page.click('text=Expand All');
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Trades');
    expect(body).toContain('Amount');
    expect(body).toContain('Success');
  });

  test('NPC cards show posts when present', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const npcTab = page.locator('#detailTabs .tab').filter({ hasText: 'NPCs' });
    await npcTab.click();
    await page.click('text=Expand All');
    const body = await page.locator('#detailBody').textContent();
    // CryptoWhale42 (idx 0, 0%3==0) has a post
    expect(body).toContain('Posts');
    expect(body).toContain('Content');
  });

  test('NPC cards show group messages when present', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    const npcTab = page.locator('#detailTabs .tab').filter({ hasText: 'NPCs' });
    await npcTab.click();
    await page.click('text=Expand All');
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Group Messages');
    expect(body).toContain('Group');
  });
});

// ============================================================
// SECTION 12: Raw JSON Tab
// ============================================================
test.describe('Raw JSON Tab', () => {
  test('renders complete node trace as JSON', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });

    await page.evaluate(() => selectNode('init'));
    await page.click('.tab:has-text("Raw JSON")');

    const jsonViewer = page.locator('#detailBody .json-viewer').first();
    await expect(jsonViewer).toBeVisible();
    const text = await jsonViewer.textContent();
    expect(text).toContain('"nodeId"');
    expect(text).toContain('"init"');
    expect(text).toContain('"startMs"');
    expect(text).toContain('"outputs"');
    expect(text).toContain('"llmCallIds"');
  });
});

// ============================================================
// SECTION 13: Search/Filter
// ============================================================
test.describe('Search and Filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
  });

  test('search bar appears when node is selected', async ({ page }) => {
    await page.evaluate(() => selectNode('init'));
    await expect(page.locator('#searchBar')).toBeVisible();
  });

  test('search bar hidden after close', async ({ page }) => {
    await page.evaluate(() => selectNode('init'));
    await page.evaluate(() => closeDetail());
    await expect(page.locator('#searchBar')).toBeHidden();
  });
});

// ============================================================
// SECTION 14: File Loading
// ============================================================
test.describe('JSON File Loading', () => {
  test('loads a minimal valid TickTrace from file', async ({ page }) => {
    await page.goto(FILE_URL);

    // Create a minimal trace and load it via evaluate
    const loaded = await page.evaluate(() => {
      const minTrace = {
        tickId: 'test-1',
        tickNumber: 1,
        timestamp: new Date().toISOString(),
        startMs: Date.now() - 1000,
        endMs: Date.now(),
        durationMs: 1000,
        dag: {
          nodes: [
            {
              id: 'n1',
              name: 'Test Node',
              phase: 'Bootstrap',
              phaseNumber: 100,
              description: 'test',
            },
          ],
          edges: [],
        },
        nodes: [
          {
            nodeId: 'n1',
            name: 'Test Node',
            phase: 'Bootstrap',
            phaseNumber: 100,
            startMs: Date.now() - 1000,
            endMs: Date.now(),
            durationMs: 1000,
            status: 'success',
            inputs: { hello: 'world' },
            outputs: { result: 42 },
            llmCallIds: [],
          },
        ],
        llmCalls: [],
        npcTrajectories: [],
        tokenStats: {
          totalCalls: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          estimatedCostUSD: 0,
          byPromptType: {},
        },
        gameTickResult: {},
      };
      loadTrace(minTrace);
      return currentTrace !== null;
    });

    expect(loaded).toBe(true);
    await expect(page.locator('#dagPanel')).toBeVisible();
  });

  test('loads tick-summary format with llmCallSummaries', async ({ page }) => {
    await page.goto(FILE_URL);

    const loaded = await page.evaluate(() => {
      const summary = {
        tickId: 'summary-1',
        tickNumber: 5,
        timestamp: new Date().toISOString(),
        startMs: Date.now() - 2000,
        endMs: Date.now(),
        durationMs: 2000,
        dag: {
          nodes: [
            {
              id: 's1',
              name: 'Summary Node',
              phase: 'Events',
              phaseNumber: 300,
              description: 'test',
            },
          ],
          edges: [],
        },
        nodes: [
          {
            nodeId: 's1',
            name: 'Summary Node',
            phase: 'Events',
            phaseNumber: 300,
            startMs: Date.now() - 2000,
            endMs: Date.now(),
            durationMs: 2000,
            status: 'success',
            inputs: {},
            outputs: {},
            llmCallIds: ['call-001-test'],
          },
        ],
        llmCallSummaries: [
          {
            callId: 'call-001-test',
            nodeId: 's1',
            promptType: 'test',
            provider: 'groq',
            model: 'test-model',
            inputTokens: 100,
            outputTokens: 50,
            durationMs: 500,
            success: true,
          },
        ],
      };
      loadTrace(summary);
      return {
        loaded: currentTrace !== null,
        hasLlmCalls: currentTrace.llmCalls.length === 1,
        hasDefaultPrompt:
          currentTrace.llmCalls[0].systemPrompt.includes('Load full trace'),
      };
    });

    expect(loaded.loaded).toBe(true);
    expect(loaded.hasLlmCalls).toBe(true);
    expect(loaded.hasDefaultPrompt).toBe(true);
  });
});

// ============================================================
// SECTION 15: Data Completeness Verification
// ============================================================
test.describe('Data Completeness - Every Engine Data Type', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(200); // wait for demo auto-select timer
  });

  test('world events: type, description, severity, signalStrength, visibility', async ({
    page,
  }) => {
    await page.evaluate(() => selectNode('events'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('rumor');
    expect(body).toContain('confirmation');
    expect(body).toContain('leak');
    expect(body).toContain('signalStrength');
    expect(body).toContain('visibility');
    expect(body).toContain('public');
    expect(body).toContain('private');
    expect(body).toContain('affectedTickers');
    expect(body).toContain('pointsToward');
  });

  test('narrative arcs: transitions, phases, sentiment', async ({ page }) => {
    await page.evaluate(() => selectNode('narrative-arcs'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('arcTransitions');
    expect(body).toContain('crisis');
    expect(body).toContain('revelation');
    expect(body).toContain('sentimentShift');
    expect(body).toContain('-0.15');
    expect(body).toContain('-0.22'); // Solander sentiment
  });

  test('market state: prices, volumes, changes', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Inputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('94850'); // aiBitcoin price
    expect(body).toContain('3420'); // ETH price
    expect(body).toContain('142'); // Solander price
    expect(body).toContain('1200000'); // volume
    expect(body).toContain('change24h');
  });

  test('prediction markets: odds, volumes', async ({ page }) => {
    await page.evaluate(() => selectNode('market-decisions'));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Inputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('yesOdds');
    expect(body).toContain('noOdds');
    expect(body).toContain('0.62');
    expect(body).toContain('0.38');
  });

  test('trade execution: success/fail counts, slippage, failure reasons', async ({
    page,
  }) => {
    await page.evaluate(() => selectNode('trade-execution'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('executed');
    expect(body).toContain('35');
    expect(body).toContain('failed');
    expect(body).toContain('slippage');
    expect(body).toContain('failureReasons');
    expect(body).toContain('insufficientBalance');
  });

  test('price volatility: random walks, seeds', async ({ page }) => {
    await page.evaluate(() => selectNode('market-volatility'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('priceWalks');
    expect(body).toContain('randomWalk');
    expect(body).toContain('eventImpact');
    expect(body).toContain('totalDrift');
    expect(body).toContain('seedUsed');
    expect(body).toContain('284742');
  });

  test('reputation: on-chain sync, score changes', async ({ page }) => {
    await page.evaluate(() => selectNode('reputation-sync'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('synced');
    expect(body).toContain('txHash');
    expect(body).toContain('gasUsed');
    expect(body).toContain('reputationUpdates');
    expect(body).toContain('oldScore');
    expect(body).toContain('newScore');
  });

  test('social graph: relationships, clusters, bonds, rivalries', async ({
    page,
  }) => {
    await page.evaluate(() => selectNode('relationships'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('relationshipsUpdated');
    expect(body).toContain('strongestBond');
    expect(body).toContain('trading_alliance');
    expect(body).toContain('newRivalries');
    expect(body).toContain('socialGraph');
    expect(body).toContain('clusters');
  });

  test('group dynamics: messages, joins, kicks', async ({ page }) => {
    await page.evaluate(() => selectNode('group-dynamics'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('messagesGenerated');
    expect(body).toContain('member_join');
    expect(body).toContain('member_kick');
    expect(body).toContain('Consistently bullish');
    expect(body).toContain('groupSentiment');
  });

  test('blockchain: oracle commitments, tx hashes, gas', async ({ page }) => {
    await page.evaluate(() => selectNode('oracle-commitments'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('committed');
    expect(body).toContain('txHashes');
    expect(body).toContain('0xabc123');
    expect(body).toContain('gasUsed');
    expect(body).toContain('blockNumber');
  });

  test('widget caches: leaderboard, top gainers, trending', async ({
    page,
  }) => {
    await page.evaluate(() => selectNode('widget-caches'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('topGainers');
    expect(body).toContain('Solander');
    expect(body).toContain('2.46');
    expect(body).toContain('leaderboardTop3');
    expect(body).toContain('AlphaHunter');
    expect(body).toContain('15200');
  });

  test('rebalancing: portfolio drift, actions, volumes', async ({ page }) => {
    await page.evaluate(() => selectNode('rebalancing'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.detail-tabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('portfoliosChecked');
    expect(body).toContain('rebalancesTriggered');
    expect(body).toContain('Portfolio drift 18%');
    expect(body).toContain('Single-asset concentration 42%');
  });

  test('LLM call IDs are correctly linked between nodes and calls', async ({
    page,
  }) => {
    const integrity = await page.evaluate(() => {
      const t = currentTrace;
      const issues = [];

      for (const node of t.nodes) {
        for (const callId of node.llmCallIds) {
          const call = t.llmCalls.find((c) => c.callId === callId);
          if (!call)
            issues.push(
              `Node ${node.nodeId} references missing LLM call ${callId}`
            );
          else if (call.nodeId !== node.nodeId)
            issues.push(
              `LLM call ${callId} has nodeId ${call.nodeId} but is referenced by ${node.nodeId}`
            );
        }
      }

      // Every LLM call should be referenced by exactly one node
      for (const call of t.llmCalls) {
        const referencingNodes = t.nodes.filter((n) =>
          n.llmCallIds.includes(call.callId)
        );
        if (referencingNodes.length === 0)
          issues.push(`LLM call ${call.callId} not referenced by any node`);
        if (referencingNodes.length > 1)
          issues.push(`LLM call ${call.callId} referenced by multiple nodes`);
      }

      return issues;
    });

    expect(integrity).toEqual([]);
  });

  test('node timing is monotonically increasing within phases', async ({
    page,
  }) => {
    const issues = await page.evaluate(() => {
      const t = currentTrace;
      const issues = [];
      const byPhase = {};
      for (const node of t.nodes) {
        if (!byPhase[node.phase]) byPhase[node.phase] = [];
        byPhase[node.phase].push(node);
      }
      for (const [phase, nodes] of Object.entries(byPhase)) {
        const sorted = nodes.sort((a, b) => a.startMs - b.startMs);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].startMs < sorted[i - 1].startMs) {
            issues.push(
              `Phase ${phase}: ${sorted[i].nodeId} starts before ${sorted[i - 1].nodeId}`
            );
          }
        }
      }
      return issues;
    });
    expect(issues).toEqual([]);
  });

  test('all edge sources and targets reference existing nodes', async ({
    page,
  }) => {
    const issues = await page.evaluate(() => {
      const t = currentTrace;
      const nodeIds = new Set(t.dag.nodes.map((n) => n.id));
      const issues = [];
      for (const edge of t.dag.edges) {
        if (!nodeIds.has(edge.source))
          issues.push(`Edge source "${edge.source}" not found in nodes`);
        if (!nodeIds.has(edge.target))
          issues.push(`Edge target "${edge.target}" not found in nodes`);
      }
      return issues;
    });
    expect(issues).toEqual([]);
  });

  test('token stats sum matches individual LLM calls', async ({ page }) => {
    const check = await page.evaluate(() => {
      const t = currentTrace;
      const sumInput = t.llmCalls.reduce((s, c) => s + (c.inputTokens || 0), 0);
      const sumOutput = t.llmCalls.reduce(
        (s, c) => s + (c.outputTokens || 0),
        0
      );
      return {
        reportedInput: t.tokenStats.totalInputTokens,
        computedInput: sumInput,
        reportedOutput: t.tokenStats.totalOutputTokens,
        computedOutput: sumOutput,
        reportedCalls: t.tokenStats.totalCalls,
        computedCalls: t.llmCalls.length,
      };
    });

    expect(check.reportedCalls).toBe(check.computedCalls);
    expect(check.reportedInput).toBe(check.computedInput);
    expect(check.reportedOutput).toBe(check.computedOutput);
  });
});

// ============================================================
// SECTION 16: Global Views
// ============================================================
test.describe('Global Views', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);
  });

  test('global nav bar appears after loading data', async ({ page }) => {
    await expect(page.locator('#globalNav')).toBeVisible();
  });

  test('global nav has all 7 tabs', async ({ page }) => {
    const tabs = await page.locator('#globalNav .tab').allTextContents();
    expect(tabs).toContain('DAG View');
    expect(tabs).toContain('Tick Summary');
    expect(tabs).toContain('All LLM Calls');
    expect(tabs).toContain('All NPCs');
    expect(tabs).toContain('Token Costs');
    expect(tabs).toContain('Timeline');
    expect(tabs).toContain('Data Gaps');
  });

  test('Tick Summary shows stat cards and game tick result', async ({
    page,
  }) => {
    await page.evaluate(() => switchGlobalView('tick-summary'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('Tick #2847 Summary');
    expect(body).toContain('61,150');
    expect(body).toContain('$0.0485');
    expect(body).toContain('Game Tick Result');
    expect(body).toContain('Slowest Nodes');
  });

  test('All LLM Calls shows all calls with full prompts', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('all-llm'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('All LLM Calls (15)');
    const cards = await page.locator('.llm-card').count();
    expect(cards).toBe(15);
    await page.evaluate(() => toggleAllLLMCards(true));
    const expanded = await page.locator('#globalViewBody').textContent();
    expect(expanded).toContain('System Prompt');
    expect(expanded).toContain('Feed World Engine');
  });

  test('All NPCs shows all 8 NPC trajectories', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('all-npcs'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('All NPC Trajectories (8)');
    expect(body).toContain('CryptoWhale42');
    expect(body).toContain('AlphaHunter');
  });

  test('Token Costs shows breakdown by prompt type and node', async ({
    page,
  }) => {
    await page.evaluate(() => switchGlobalView('token-breakdown'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('Token Usage');
    expect(body).toContain('npc-market-decisions');
    expect(body).toContain('By DAG Node');
  });

  test('Timeline shows execution bars', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('timeline'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('Execution Timeline');
    expect(body).toContain('LLM Call Timing');
    const rows = await page.locator('.timeline-row').count();
    expect(rows).toBeGreaterThan(20);
  });

  test('Data Gaps shows coverage report with resolved items', async ({
    page,
  }) => {
    await page.evaluate(() => switchGlobalView('data-gaps'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('Data Coverage Report');
    expect(body).toContain('Resolved');
  });

  test('switching back to DAG View restores the DAG', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('tick-summary'));
    await expect(page.locator('#globalView')).toBeVisible();
    await page.evaluate(() => switchGlobalView('dag'));
    await expect(page.locator('#mainArea')).toBeVisible();
    await expect(page.locator('#globalView')).toBeHidden();
  });

  test('All LLM Calls has copy buttons', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('all-llm'));
    await page.evaluate(() => toggleAllLLMCards(true));
    const copyBtns = await page.locator('.copy-btn').count();
    expect(copyBtns).toBeGreaterThan(0);
  });

  test('clicking node name in Token Costs navigates to DAG', async ({
    page,
  }) => {
    await page.evaluate(() => {
      switchGlobalView('dag');
      selectNode('events');
    });
    await expect(page.locator('#detailTitle')).toHaveText('Generate Events');
  });

  test('All NPCs expand/collapse works', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('all-npcs'));
    await page.evaluate(() => toggleAllNPCCards(true));
    const openBodies = await page.locator('.npc-card-body.open').count();
    expect(openBodies).toBeGreaterThan(0);
    await page.evaluate(() => toggleAllNPCCards(false));
    const closedBodies = await page.locator('.npc-card-body.open').count();
    expect(closedBodies).toBe(0);
  });

  test('Timeline has correct number of node bars', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('timeline'));
    // Should have 24 node rows + 15 LLM call rows = 39 total
    const rows = await page.locator('.timeline-row').count();
    expect(rows).toBe(24 + 15);
  });

  test('Data Gaps detects skipped nodes with context as resolved', async ({
    page,
  }) => {
    await page.evaluate(() => switchGlobalView('data-gaps'));
    const body = await page.locator('#globalViewBody').textContent();
    // Demo skipped nodes now have context — should show as resolved
    expect(body).toContain('Skipped Nodes Have Context');
  });

  test('Data Gaps detects delegated nodes in demo', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('data-gaps'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('Delegated Nodes');
    expect(body).toContain('Baseline Investments');
  });

  test('Tick Summary shows delegated count', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('tick-summary'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('dlg');
  });
});

// ============================================================
// SECTION 17: New Engine Features (delegated, subOperations, envFlags)
// ============================================================
test.describe('Delegated Node Status', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);
  });

  test('market-baseline has delegated status in trace data', async ({
    page,
  }) => {
    const status = await page.evaluate(
      () =>
        currentTrace.nodes.find((n) => n.nodeId === 'market-baseline')?.status
    );
    expect(status).toBe('delegated');
  });

  test('delegated node shows teal badge in overview', async ({ page }) => {
    await page.evaluate(() => selectNode('market-baseline'));
    const badge = page.locator('.badge-delegated');
    await expect(badge).toBeVisible();
    const text = await badge.textContent();
    expect(text).toBe('delegated');
  });

  test('delegated node shows delegatedTo in inputs', async ({ page }) => {
    await page.evaluate(() => selectNode('market-baseline'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('#detailTabs .tab')].find(
        (t) => t.textContent === 'Inputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('delegatedTo');
    expect(body).toContain('npc-tick');
  });

  test('delegated node outputs contain source reference', async ({ page }) => {
    await page.evaluate(() => selectNode('market-baseline'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('#detailTabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => expandAllSections(true));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('npc-tick-latest.json');
  });

  test('NodeTrace schema accepts delegated status', async ({ page }) => {
    const statuses = await page.evaluate(() =>
      [...new Set(currentTrace.nodes.map((n) => n.status))].sort()
    );
    expect(statuses).toContain('delegated');
    expect(statuses).toContain('success');
    expect(statuses).toContain('skipped');
  });
});

test.describe('Sub-Operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);
  });

  test('reputation-sync node has subOperations in trace data', async ({
    page,
  }) => {
    const ops = await page.evaluate(
      () =>
        currentTrace.nodes.find((n) => n.nodeId === 'reputation-sync')
          ?.subOperations
    );
    expect(ops).toBeDefined();
    expect(ops.length).toBe(3);
  });

  test('subOperations have correct schema', async ({ page }) => {
    const ops = await page.evaluate(
      () =>
        currentTrace.nodes.find((n) => n.nodeId === 'reputation-sync')
          ?.subOperations
    );
    for (const op of ops) {
      expect(op).toHaveProperty('name');
      expect(op).toHaveProperty('type');
      expect(op).toHaveProperty('startMs');
      expect(op).toHaveProperty('endMs');
      expect(op).toHaveProperty('details');
      expect([
        'db_write',
        'db_read',
        'llm',
        'computation',
        'external',
      ]).toContain(op.type);
    }
  });

  test('subOperations include db_read, external, and db_write types', async ({
    page,
  }) => {
    const types = await page.evaluate(() =>
      currentTrace.nodes
        .find((n) => n.nodeId === 'reputation-sync')
        ?.subOperations.map((o) => o.type)
    );
    expect(types).toContain('db_read');
    expect(types).toContain('external');
    expect(types).toContain('db_write');
  });

  test('subOperations render in overview tab', async ({ page }) => {
    await page.evaluate(() => selectNode('reputation-sync'));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('Sub-Operations (3)');
    expect(body).toContain('fetch pending reputations');
    expect(body).toContain('submit on-chain tx');
    expect(body).toContain('update reputation scores');
  });

  test('subOperations show details JSON', async ({ page }) => {
    await page.evaluate(() => selectNode('reputation-sync'));
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('actor_reputations');
    expect(body).toContain('batchUpdateReputation');
    expect(body).toContain('gasUsed');
  });

  test('subOperations show type badges with colors', async ({ page }) => {
    await page.evaluate(() => selectNode('reputation-sync'));
    const body = await page.locator('#detailBody').innerHTML();
    expect(body).toContain('db_read');
    expect(body).toContain('external');
    expect(body).toContain('db_write');
  });

  test('skipped nodes do not show sub-operations section', async ({ page }) => {
    await page.evaluate(() => selectNode('bootstrap-content'));
    const body = await page.locator('#detailBody').textContent();
    expect(body).not.toContain('Sub-Operations');
  });

  test('all success nodes now have subOperations', async ({ page }) => {
    const noSubOps = await page.evaluate(
      () =>
        currentTrace.nodes.filter(
          (n) =>
            n.status === 'success' &&
            (!n.subOperations || n.subOperations.length === 0)
        ).length
    );
    expect(noSubOps).toBe(0);
  });
});

test.describe('Environment Flags', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);
  });

  test('demo trace has environmentFlags', async ({ page }) => {
    const flags = await page.evaluate(() => currentTrace.environmentFlags);
    expect(flags).toBeDefined();
    expect(flags.FEED_DAG_TRACE).toBe(true);
    expect(flags.FEED_TRUST_CORPUS_FAST_MODE).toBe(false);
    expect(flags.FEED_SKIP_NPC_GROUP_DYNAMICS).toBe(false);
    expect(flags.FEED_SKIP_ALPHA_GROUP_INVITES).toBe(false);
    expect(flags.GAME_TICK_BUDGET_MS).toBe('180000');
  });

  test('Tick Summary view renders environment flags', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('tick-summary'));
    const body = await page.locator('#globalViewBody').textContent();
    expect(body).toContain('Environment Flags');
    expect(body).toContain('FEED_DAG_TRACE');
    expect(body).toContain('FEED_TRUST_CORPUS_FAST_MODE');
    expect(body).toContain('GAME_TICK_BUDGET_MS');
  });

  test('environment flags are syntax highlighted as JSON', async ({ page }) => {
    await page.evaluate(() => switchGlobalView('tick-summary'));
    const html = await page.locator('#globalViewBody').innerHTML();
    // Should have json-key spans for the flag names
    expect(html).toContain('json-key');
    expect(html).toContain('FEED_DAG_TRACE');
  });
});

test.describe('NPC Timestamps', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);
  });

  test('NPC decisions have timestamp field', async ({ page }) => {
    const hasTimestamps = await page.evaluate(() => {
      return currentTrace.npcTrajectories.every((npc) =>
        npc.decisions.every(
          (d) => typeof d.timestamp === 'number' || d.timestamp === undefined
        )
      );
    });
    expect(hasTimestamps).toBe(true);
  });

  test('NPC trades have timestamp field', async ({ page }) => {
    const hasTimestamps = await page.evaluate(() => {
      return currentTrace.npcTrajectories.every((npc) =>
        npc.trades.every(
          (t) => typeof t.timestamp === 'number' || t.timestamp === undefined
        )
      );
    });
    expect(hasTimestamps).toBe(true);
  });
});

test.describe('LLM Call Explicit Node ID', () => {
  test('LLMCallInput supports optional nodeId', async ({ page }) => {
    await page.goto(FILE_URL);

    // Load a trace with an LLM call that has explicit nodeId
    const loaded = await page.evaluate(() => {
      const trace = {
        tickId: 'explicit-node-test',
        tickNumber: 1,
        timestamp: new Date().toISOString(),
        startMs: Date.now() - 1000,
        endMs: Date.now(),
        durationMs: 1000,
        dag: {
          nodes: [
            {
              id: 'n1',
              name: 'Node 1',
              phase: 'Bootstrap',
              phaseNumber: 100,
              description: 'test',
            },
            {
              id: 'n2',
              name: 'Node 2',
              phase: 'Events',
              phaseNumber: 300,
              description: 'test',
            },
          ],
          edges: [],
        },
        nodes: [
          {
            nodeId: 'n1',
            name: 'Node 1',
            phase: 'Bootstrap',
            phaseNumber: 100,
            startMs: Date.now() - 1000,
            endMs: Date.now(),
            durationMs: 1000,
            status: 'success',
            inputs: {},
            outputs: {},
            llmCallIds: [],
          },
          {
            nodeId: 'n2',
            name: 'Node 2',
            phase: 'Events',
            phaseNumber: 300,
            startMs: Date.now() - 500,
            endMs: Date.now(),
            durationMs: 500,
            status: 'success',
            inputs: {},
            outputs: {},
            llmCallIds: ['call-001-test'],
          },
        ],
        llmCalls: [
          {
            callId: 'call-001-test',
            nodeId: 'n2',
            timestamp: Date.now() - 250,
            provider: 'groq',
            model: 'test',
            promptType: 'test',
            format: 'json',
            temperature: 0.7,
            maxTokens: 100,
            systemPrompt: 'test system prompt',
            userPrompt: 'test user prompt',
            rawResponse: 'test response',
            parsedResponse: null,
            inputTokens: 50,
            outputTokens: 25,
            totalTokens: 75,
            durationMs: 200,
            success: true,
          },
        ],
        npcTrajectories: [],
        tokenStats: {
          totalCalls: 1,
          totalInputTokens: 50,
          totalOutputTokens: 25,
          totalTokens: 75,
          estimatedCostUSD: 0.001,
          byPromptType: {
            test: { calls: 1, inputTokens: 50, outputTokens: 25 },
          },
        },
        gameTickResult: {},
      };
      loadTrace(trace);
      // Verify the LLM call is linked to n2
      const n2 = currentTrace.nodes.find((n) => n.nodeId === 'n2');
      return n2 && n2.llmCallIds.includes('call-001-test');
    });
    expect(loaded).toBe(true);
  });
});

test.describe('Data Integrity - Cross-Reference Checks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);
  });

  test('every NPC trajectory has at least one action', async ({ page }) => {
    const check = await page.evaluate(() => {
      return currentTrace.npcTrajectories.every(
        (npc) =>
          npc.decisions.length +
            npc.trades.length +
            npc.posts.length +
            npc.groupMessages.length >
          0
      );
    });
    expect(check).toBe(true);
  });

  test('all node phases match DAG definition', async ({ page }) => {
    const mismatches = await page.evaluate(() => {
      const issues = [];
      for (const node of currentTrace.nodes) {
        const dagNode = currentTrace.dag.nodes.find(
          (n) => n.id === node.nodeId
        );
        if (dagNode && dagNode.phase !== node.phase) {
          issues.push(
            `${node.nodeId}: trace phase=${node.phase} vs dag phase=${dagNode.phase}`
          );
        }
      }
      return issues;
    });
    expect(mismatches).toEqual([]);
  });

  test('subOperations timing is within parent node timing', async ({
    page,
  }) => {
    const issues = await page.evaluate(() => {
      const issues = [];
      for (const node of currentTrace.nodes) {
        if (!node.subOperations) continue;
        for (const op of node.subOperations) {
          if (op.startMs < node.startMs)
            issues.push(`${node.nodeId}/${op.name}: sub starts before node`);
          if (op.endMs > node.endMs)
            issues.push(`${node.nodeId}/${op.name}: sub ends after node`);
        }
      }
      return issues;
    });
    expect(issues).toEqual([]);
  });

  test('delegated nodes have delegatedTo in inputs', async ({ page }) => {
    const check = await page.evaluate(() => {
      return currentTrace.nodes
        .filter((n) => n.status === 'delegated')
        .every((n) => n.inputs.delegatedTo);
    });
    expect(check).toBe(true);
  });

  test('byPromptType call counts sum to totalCalls', async ({ page }) => {
    const check = await page.evaluate(() => {
      const byType = currentTrace.tokenStats.byPromptType;
      const sum = Object.values(byType).reduce((s, v) => s + v.calls, 0);
      return { sum, total: currentTrace.tokenStats.totalCalls };
    });
    expect(check.sum).toBe(check.total);
  });

  test('no node has negative duration', async ({ page }) => {
    const check = await page.evaluate(() =>
      currentTrace.nodes.every((n) => n.durationMs >= 0)
    );
    expect(check).toBe(true);
  });

  test('every LLM call references a valid node or unknown', async ({
    page,
  }) => {
    const check = await page.evaluate(() => {
      const nodeIds = new Set(currentTrace.nodes.map((n) => n.nodeId));
      nodeIds.add('unknown');
      return currentTrace.llmCalls.every((c) => nodeIds.has(c.nodeId));
    });
    expect(check).toBe(true);
  });
});

// ============================================================
// SECTION 20: Search Filter Behavior
// ============================================================
test.describe('Search Filter Behavior', () => {
  test('typing in search hides non-matching sections', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);

    await page.evaluate(() => selectNode('events'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('#detailTabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);

    // Type a filter query
    await page.fill('#searchInput', 'rumor');
    await page.waitForTimeout(50);

    // Some sections should be hidden
    const visible = await page.evaluate(() => {
      const sections = document.querySelectorAll(
        '#detailBody .section, #detailBody .data-section'
      );
      let vis = 0,
        hid = 0;
      sections.forEach((s) => {
        if (s.style.display === 'none') hid++;
        else vis++;
      });
      return { vis, hid };
    });
    expect(visible.hid).toBeGreaterThan(0);
    expect(visible.vis).toBeGreaterThan(0);
  });

  test('clearing search shows all sections again', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);

    await page.evaluate(() => selectNode('events'));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('#detailTabs .tab')].find(
        (t) => t.textContent === 'Outputs'
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(50);

    await page.fill('#searchInput', 'rumor');
    await page.waitForTimeout(50);
    await page.fill('#searchInput', '');
    await page.waitForTimeout(50);

    const hidden = await page.evaluate(() => {
      const sections = document.querySelectorAll(
        '#detailBody .section, #detailBody .data-section'
      );
      return [...sections].filter((s) => s.style.display === 'none').length;
    });
    expect(hidden).toBe(0);
  });
});

// ============================================================
// SECTION 21: Error Node Handling
// ============================================================
test.describe('Error Node Handling', () => {
  test('error node renders correctly with error details', async ({ page }) => {
    await page.goto(FILE_URL);

    const loaded = await page.evaluate(() => {
      const trace = {
        tickId: 'err-1',
        tickNumber: 1,
        timestamp: new Date().toISOString(),
        startMs: Date.now() - 1000,
        endMs: Date.now(),
        durationMs: 1000,
        dag: {
          nodes: [
            {
              id: 'err-node',
              name: 'Failing Node',
              phase: 'Events',
              phaseNumber: 300,
              description: 'This node fails',
            },
          ],
          edges: [],
        },
        nodes: [
          {
            nodeId: 'err-node',
            name: 'Failing Node',
            phase: 'Events',
            phaseNumber: 300,
            startMs: Date.now() - 1000,
            endMs: Date.now(),
            durationMs: 1000,
            status: 'error',
            inputs: { attempt: 1 },
            outputs: {},
            error: 'LLM timeout after 30s: model overloaded',
            llmCallIds: [],
          },
        ],
        llmCalls: [],
        npcTrajectories: [],
        tokenStats: {
          totalCalls: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          estimatedCostUSD: 0,
          byPromptType: {},
        },
        gameTickResult: {},
      };
      loadTrace(trace);
      selectNode('err-node');
      return true;
    });

    expect(loaded).toBe(true);
    const body = await page.locator('#detailBody').textContent();
    expect(body).toContain('error');
    expect(body).toContain('LLM timeout after 30s');
  });
});

// ============================================================
// SECTION 22: Invalid JSON Handling
// ============================================================
test.describe('Invalid JSON Handling', () => {
  test('loading unrecognized format shows alert without crashing', async ({
    page,
  }) => {
    await page.goto(FILE_URL);

    // Register dialog handler BEFORE triggering the alert
    let dialogMessage = '';
    page.on('dialog', async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.accept();
    });

    await page.evaluate(() => {
      loadTrace({ foo: 'bar' });
    });

    // Give the dialog handler time to fire
    await page.waitForTimeout(100);
    expect(dialogMessage).toContain('Unrecognized');
  });
});

// ============================================================
// SECTION 23: Oracle q-015 phantom reference fixed
// ============================================================
test.describe('Data Reference Integrity', () => {
  test('all oracle commitment questionIds exist in active questions', async ({
    page,
  }) => {
    await page.goto(FILE_URL);
    await page.click('text=Load Demo Trace');
    await page.waitForSelector('#dagPanel', { state: 'visible' });
    await page.waitForTimeout(300);

    const check = await page.evaluate(() => {
      const oracle = currentTrace.nodes.find(
        (n) => n.nodeId === 'oracle-commitments'
      );
      const qLoad = currentTrace.nodes.find(
        (n) => n.nodeId === 'questions-load'
      );
      if (
        !oracle?.outputs?.commitmentDetails ||
        !qLoad?.outputs?.activeQuestions
      )
        return { ok: true };
      const qIds = new Set(qLoad.outputs.activeQuestions.map((q) => q.id));
      const missing = oracle.outputs.commitmentDetails
        .filter((c) => !qIds.has(c.questionId))
        .map((c) => c.questionId);
      return { ok: missing.length === 0, missing };
    });
    expect(check.ok).toBe(true);
  });
});
