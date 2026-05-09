import { describe, expect, test } from 'bun:test';
import { WORKFLOW_GENERATION_SYSTEM_PROMPT } from '../../src/prompts/workflowGeneration';

describe('WORKFLOW_GENERATION_SYSTEM_PROMPT — name→id resolution rules', () => {
  test('declares display-name → id resolution as mandatory', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain(
      'Display-name → id resolution is mandatory when a fact line covers it'
    );
  });

  test('forbids leading "#" sensitivity and demands case-insensitive name match', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(/case-insensitively/);
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(/leading `#`/);
  });

  test('forbids guessed ids when a fact line resolves the target', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain(
      'Never emit a placeholder, a guessed id, or the display name itself'
    );
  });

  test('walks the LLM through a concrete Cozy Devs / #general resolution', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(/Cozy Devs/);
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(/9876543210/);
  });
});

describe('WORKFLOW_GENERATION_SYSTEM_PROMPT — structured ClarificationRequest rules', () => {
  test('documents the structured ClarificationRequest object format', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('Structured ClarificationRequest format');
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('"kind"');
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('"paramPath"');
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('"scope"');
  });

  test('lists all five clarification kinds', () => {
    for (const kind of ['target_channel', 'target_server', 'recipient', 'value', 'free_text']) {
      expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain(kind);
    }
  });

  test('demands paramPath point at the exact JSON path with bracketed-string syntax', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('bracketed string syntax');
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain(
      'nodes["Discord Send"].parameters.channelId'
    );
  });

  test('instructs the LLM to leave the unresolved parameter absent', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(
      /Stop populating that parameter — leave it absent/
    );
  });

  test('shows the chained server→channel picker example', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(/send me a daily reminder on Discord/);
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(
      /chained channel-picker clarification with `scope.guildId`/
    );
  });

  test('teaches the ambiguous-channel example with a concrete payload', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(/post a daily reminder to Cozy Devs/);
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('"target_channel"');
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toContain('"Which channel in Cozy Devs?"');
  });

  test('lists the new "do NOT clarify already-resolvable targets" rule', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(
      /Targets you can resolve directly from `## Runtime Facts` — those MUST be filled in, not asked about/
    );
  });

  test('lists the new "DO clarify unresolvable targets" rule', () => {
    expect(WORKFLOW_GENERATION_SYSTEM_PROMPT).toMatch(
      /references a target.*and `## Runtime Facts` does NOT contain a matching entry/s
    );
  });
});
