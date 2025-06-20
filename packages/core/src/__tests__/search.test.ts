import { describe, it, expect } from 'bun:test';
import { BM25 } from '../search';

describe('BM25 search', () => {
  it('indexes documents and finds matches', () => {
    const docs = [
      { text: 'hello world' },
      { text: 'another document' },
      { text: 'world of javascript' },
    ];
    const bm = new BM25(docs, { fieldBoosts: { text: 1 } });
    const results = bm.search('world');
    expect(results[0].index).toBe(0);
  });
});
