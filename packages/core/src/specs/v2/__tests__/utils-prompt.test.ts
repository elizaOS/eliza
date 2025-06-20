import { describe, it, expect, mock } from 'bun:test';
import * as utils from '../utils';
import { ModelType } from '../types';

describe('prompt utilities', () => {
  it('composePrompt inserts state values', () => {
    //const spy = vi.spyOn(utils, 'composeRandomUser').mockImplementation((t) => t);
    const out = utils.composePrompt({ state: { a: 'x' }, template: 'Hello {{a}}' });
    expect(out).toBe('Hello x');
    //spy.mockRestore();
  });

  it('composePromptFromState flattens state values', () => {
    //const spy = vi.spyOn(utils, 'composeRandomUser').mockImplementation((t) => t);
    const out = utils.composePromptFromState({
      state: {
        values: { b: 'y', c: 'z' },
        data: {},
        text: '',
      },
      template: '{{b}} {{c}}',
    });
    expect(out).toBe('y z');
    //spy.mockRestore();
  });

  it('formatPosts formats conversation text', () => {
    const messages = [
      {
        id: '1',
        entityId: 'e1',
        roomId: 'r1',
        createdAt: 1,
        content: { text: 'hi', source: 'chat' },
      },
      {
        id: '2',
        entityId: 'e1',
        roomId: 'r1',
        createdAt: 2,
        content: { text: 'there', source: 'chat' },
      },
    ] as any;
    const entities = [{ id: 'e1', names: ['Alice'] }] as any;
    const result = utils.formatPosts({ messages, entities });
    expect(result).toContain('Conversation:');
    expect(result).toContain('Alice');
    expect(result).toContain('hi');
    expect(result).toContain('there');
  });

  it('trimTokens truncates using runtime tokenizer', async () => {
    const runtime = {
      useModel: mock(async (type: string, { prompt, tokens }: any) => {
        if (type === ModelType.TEXT_TOKENIZER_ENCODE) return prompt.split(' ');
        if (type === ModelType.TEXT_TOKENIZER_DECODE) return tokens.join(' ');
        return [];
      }),
    } as any;
    const result = await utils.trimTokens('a b c d e', 3, runtime);
    expect(result).toBe('c d e');
  });
});
