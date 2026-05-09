import { describe, expect, test } from 'bun:test';
import {
  applyResolutions,
  coerceClarifications,
  setByDotPath,
} from '../../src/lib/workflow-clarification';

describe('setByDotPath', () => {
  test('writes through a numeric array index (existing behavior)', () => {
    const obj: Record<string, unknown> = {
      nodes: [
        { name: 'A', parameters: {} },
        { name: 'B', parameters: {} },
      ],
    };
    setByDotPath(obj, 'nodes[1].parameters.channelId', 'C-123');
    expect((obj.nodes as any)[1].parameters.channelId).toBe('C-123');
    expect((obj.nodes as any)[0].parameters).toEqual({});
  });

  test('resolves a string array segment by entry .name (workflow nodes)', () => {
    const obj: Record<string, unknown> = {
      nodes: [
        { name: 'Webhook', parameters: { path: '/in' } },
        { name: 'Post to Slack', parameters: {} },
      ],
    };
    setByDotPath(obj, 'nodes["Post to Slack"].parameters.channelId', 'C-42');
    expect((obj.nodes as any)[1].parameters.channelId).toBe('C-42');
    expect((obj.nodes as any)[0].parameters.path).toBe('/in');
  });

  test('resolves a string array segment by entry .id when name does not match', () => {
    const obj: Record<string, unknown> = {
      nodes: [{ id: 'uuid-slack', name: 'Post to Slack', parameters: {} }],
    };
    setByDotPath(obj, 'nodes["uuid-slack"].parameters.channelId', 'C-99');
    expect((obj.nodes as any)[0].parameters.channelId).toBe('C-99');
  });

  test('throws when string segment matches no element by name or id', () => {
    const obj: Record<string, unknown> = {
      nodes: [{ name: 'Webhook', parameters: {} }],
    };
    expect(() =>
      setByDotPath(obj, 'nodes["Placeholder Notification"].parameters.x', 'y')
    ).toThrow(/did not match any element by name\/id/);
  });

  test('dot identifiers still work end-to-end', () => {
    const obj: Record<string, unknown> = { a: { b: { c: 1 } } };
    setByDotPath(obj, 'a.b.c', 42);
    expect((obj.a as any).b.c).toBe(42);
  });

  test('refuses to overwrite an object with a non-object value (object case)', () => {
    // The LLM sometimes points paramPath at a parent scope. Without this
    // guard, the assignment silently replaces the parameters object with
    // a string and the workflow runner rejects the deploy with `parameters
    // must be object`.
    const obj: Record<string, unknown> = {
      nodes: [{ name: 'Trigger', parameters: { existing: 'field' } }],
    };
    expect(() => setByDotPath(obj, 'nodes["Trigger"].parameters', 'discord')).toThrow(
      /refusing to overwrite with non-object value/
    );
    expect((obj.nodes as any)[0].parameters).toEqual({ existing: 'field' });
  });

  test('refuses to overwrite an object inside an array (array case)', () => {
    const obj: Record<string, unknown> = {
      items: [{ a: 1 }, { b: 2 }],
    };
    expect(() => setByDotPath(obj, 'items.0', 'string')).toThrow(
      /refusing to overwrite with non-object value/
    );
  });

  test('allows replacing a primitive with another primitive', () => {
    const obj: Record<string, unknown> = {
      nodes: [{ name: 'T', parameters: { hour: 9 } }],
    };
    setByDotPath(obj, 'nodes["T"].parameters.hour', 10);
    expect((obj.nodes as any)[0].parameters.hour).toBe(10);
  });

  test('allows replacing an object with another object', () => {
    const obj: Record<string, unknown> = {
      nodes: [{ name: 'T', parameters: { old: 'x' } }],
    };
    setByDotPath(obj, 'nodes["T"].parameters', { new: 'y' });
    expect((obj.nodes as any)[0].parameters).toEqual({ new: 'y' });
  });
});

describe('applyResolutions', () => {
  test('applies a name-keyed paramPath to the matching node', () => {
    const draft: Record<string, unknown> = {
      nodes: [
        { name: 'Hourly Trigger', parameters: { rule: 'everyHour' } },
        { name: 'Notify', parameters: {} },
      ],
    };
    const result = applyResolutions(draft, [
      { paramPath: 'nodes["Notify"].parameters.channelId', value: 'discord-channel-1' },
    ]);
    expect(result.ok).toBe(true);
    expect((draft.nodes as any)[1].parameters.channelId).toBe('discord-channel-1');
  });

  test('falls back to userNotes when paramPath references a non-existent node', () => {
    const draft: Record<string, unknown> = {
      nodes: [{ name: 'Hourly Trigger', parameters: {} }],
    };
    const result = applyResolutions(draft, [
      { paramPath: 'nodes["Placeholder Notification"].parameters', value: 'discord' },
    ]);
    expect(result.ok).toBe(true);
    const meta = (draft as any)._meta;
    expect(meta).toBeDefined();
    expect(meta.userNotes).toEqual(['discord']);
    expect((draft.nodes as any).length).toBe(1);
    expect((draft.nodes as any)[0].name).toBe('Hourly Trigger');
  });

  test('falls back to userNotes when paramPath points at a parent object scope', () => {
    // The exact LLM failure: clarification asked for a notification channel
    // but paramPath was `nodes["Trigger"].parameters` — the parameters object
    // itself, not a leaf field. Old behavior overwrote parameters with the
    // string "discord" and broke deploy.
    const draft: Record<string, unknown> = {
      nodes: [{ name: 'Hourly Trigger', parameters: { mode: 'everyHour' } }],
    };
    const result = applyResolutions(draft, [
      { paramPath: 'nodes["Hourly Trigger"].parameters', value: 'discord' },
    ]);
    expect(result.ok).toBe(true);
    expect((draft as any)._meta.userNotes).toEqual(['discord']);
    expect((draft.nodes as any)[0].parameters).toEqual({ mode: 'everyHour' });
  });

  test('falls back to userNotes when paramPath descends into a non-object', () => {
    const draft: Record<string, unknown> = {
      nodes: [{ name: 'X', parameters: 'this is a string not an object' }],
    };
    const result = applyResolutions(draft, [
      { paramPath: 'nodes["X"].parameters.channelId', value: 'C-1' },
    ]);
    expect(result.ok).toBe(true);
    expect((draft as any)._meta.userNotes).toEqual(['C-1']);
  });

  test('empty paramPath stores answer as userNote (existing behavior)', () => {
    const draft: Record<string, unknown> = { nodes: [], connections: {} };
    const result = applyResolutions(draft, [{ paramPath: '', value: 'use email' }]);
    expect(result.ok).toBe(true);
    expect((draft as any)._meta.userNotes).toEqual(['use email']);
  });

  test('multiple resolutions can mix successful path writes and userNote fallbacks', () => {
    const draft: Record<string, unknown> = {
      nodes: [{ name: 'Real Node', parameters: {} }],
    };
    const result = applyResolutions(draft, [
      { paramPath: 'nodes["Real Node"].parameters.target', value: 'ok' },
      { paramPath: 'nodes["Imaginary Node"].parameters.target', value: 'fallback' },
      { paramPath: '', value: 'free-form note' },
    ]);
    expect(result.ok).toBe(true);
    expect((draft.nodes as any)[0].parameters.target).toBe('ok');
    expect((draft as any)._meta.userNotes).toEqual(['fallback', 'free-form note']);
  });

  test('non-string value still rejects the batch (validation, not path failure)', () => {
    const draft: Record<string, unknown> = { nodes: [] };
    const result = applyResolutions(draft, [
      // @ts-expect-error — testing runtime guard
      { paramPath: 'x', value: 42 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be a string');
    }
  });

  test('structurally invalid paramPath fails the batch (does not silently fall through to userNotes)', () => {
    const draft: Record<string, unknown> = { nodes: [] };
    const result = applyResolutions(draft, [{ paramPath: 'nodes["Unclosed', value: 'X' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('structurally invalid');
      expect(result.paramPath).toBe('nodes["Unclosed');
    }
    expect((draft as any)._meta).toBeUndefined();
  });
});

describe('coerceClarifications — sort order', () => {
  test('target_server is asked before target_channel even when LLM emits reverse order', () => {
    const raw = [
      {
        kind: 'target_channel',
        platform: 'discord',
        question: 'Which Discord channel should receive the alert?',
        paramPath: 'nodes["Send"].parameters.channelId',
      },
      {
        kind: 'target_server',
        platform: 'discord',
        question: 'Which Discord server?',
        paramPath: 'nodes["Send"].parameters.guildId',
      },
    ];
    const out = coerceClarifications(raw);
    expect(out.map((c) => c.kind)).toEqual(['target_server', 'target_channel']);
  });

  test('preserves LLM order within the same kind bucket (stable sort)', () => {
    const raw = [
      { kind: 'value', question: 'First value', paramPath: 'a' },
      { kind: 'value', question: 'Second value', paramPath: 'b' },
      { kind: 'value', question: 'Third value', paramPath: 'c' },
    ];
    const out = coerceClarifications(raw);
    expect(out.map((c) => c.question)).toEqual(['First value', 'Second value', 'Third value']);
  });

  test('recipient sorts after target_server (recipient depends on server context)', () => {
    const raw = [
      {
        kind: 'recipient',
        platform: 'slack',
        question: 'Which user to DM?',
        paramPath: 'nodes["DM"].parameters.userId',
      },
      {
        kind: 'target_server',
        platform: 'slack',
        question: 'Which Slack workspace?',
        paramPath: 'nodes["DM"].parameters.workspaceId',
      },
    ];
    const out = coerceClarifications(raw);
    expect(out[0].kind).toBe('target_server');
    expect(out[1].kind).toBe('recipient');
  });

  test('free_text drops to the end', () => {
    const raw = [
      { kind: 'free_text', question: 'Anything else to note?', paramPath: '' },
      {
        kind: 'value',
        question: 'What hour to run?',
        paramPath: 'nodes["Cron"].parameters.hour',
      },
      {
        kind: 'target_server',
        platform: 'discord',
        question: 'Which server?',
        paramPath: 'nodes["Send"].parameters.guildId',
      },
    ];
    const out = coerceClarifications(raw);
    expect(out.map((c) => c.kind)).toEqual(['target_server', 'value', 'free_text']);
  });

  test('legacy bare-string clarifications normalize to free_text and stay at the end', () => {
    const raw = [
      'Anything special about your setup?',
      {
        kind: 'target_server',
        platform: 'discord',
        question: 'Which server?',
        paramPath: 'x',
      },
    ];
    const out = coerceClarifications(raw);
    expect(out[0].kind).toBe('target_server');
    expect(out[1].kind).toBe('free_text');
    expect(out[1].question).toBe('Anything special about your setup?');
  });

  test('mixed multi-platform: server-then-channel ordering applies per platform group', () => {
    const raw = [
      { kind: 'target_channel', platform: 'discord', question: 'Discord channel?', paramPath: 'x' },
      { kind: 'target_channel', platform: 'slack', question: 'Slack channel?', paramPath: 'y' },
      { kind: 'target_server', platform: 'discord', question: 'Discord server?', paramPath: 'z' },
      { kind: 'target_server', platform: 'slack', question: 'Slack workspace?', paramPath: 'w' },
    ];
    const out = coerceClarifications(raw);
    expect(out[0].kind).toBe('target_server');
    expect(out[1].kind).toBe('target_server');
    expect(out[2].kind).toBe('target_channel');
    expect(out[3].kind).toBe('target_channel');
    expect(out[0].platform).toBe('discord');
    expect(out[1].platform).toBe('slack');
  });
});
