import { describe, expect, it } from 'bun:test';
import {
  PassthroughExtractor,
  MarkableExtractor,
  XmlTagExtractor,
  ResponseStreamExtractor,
  ActionStreamFilter,
  ValidationStreamExtractor,
  type IStreamExtractor,
} from '../../utils/streaming';
import type { SchemaRow, StreamEvent } from '../../types';

// ============================================================================
// IStreamExtractor interface conformance
// ============================================================================

describe('IStreamExtractor interface', () => {
  it('PassthroughExtractor implements IStreamExtractor', () => {
    const extractor: IStreamExtractor = new PassthroughExtractor();
    expect(extractor.done).toBe(false);
    expect(typeof extractor.push).toBe('function');
  });

  it('XmlTagExtractor implements IStreamExtractor', () => {
    const extractor: IStreamExtractor = new XmlTagExtractor('text');
    expect(extractor.done).toBe(false);
    expect(typeof extractor.push).toBe('function');
  });

  it('ResponseStreamExtractor implements IStreamExtractor', () => {
    const extractor: IStreamExtractor = new ResponseStreamExtractor();
    expect(extractor.done).toBe(false);
    expect(typeof extractor.push).toBe('function');
  });

  it('ActionStreamFilter implements IStreamExtractor', () => {
    const extractor: IStreamExtractor = new ActionStreamFilter();
    expect(extractor.done).toBe(false);
    expect(typeof extractor.push).toBe('function');
  });
});

// ============================================================================
// PassthroughExtractor
// ============================================================================

describe('PassthroughExtractor', () => {
  it('should pass through all content immediately', () => {
    const extractor = new PassthroughExtractor();
    expect(extractor.push('Hello')).toBe('Hello');
    expect(extractor.push(' world!')).toBe(' world!');
  });

  it('should never be done', () => {
    const extractor = new PassthroughExtractor();
    extractor.push('content');
    expect(extractor.done).toBe(false);
  });

  it('should handle empty strings', () => {
    const extractor = new PassthroughExtractor();
    expect(extractor.push('')).toBe('');
  });
});

// ============================================================================
// MarkableExtractor
// ============================================================================

describe('MarkableExtractor', () => {
  it('should pass through all content immediately', () => {
    const extractor = new MarkableExtractor();
    expect(extractor.push('Hello')).toBe('Hello');
    expect(extractor.push(' world!')).toBe(' world!');
  });

  it('should start with done = false', () => {
    const extractor = new MarkableExtractor();
    expect(extractor.done).toBe(false);
  });

  it('should set done = true after markComplete()', () => {
    const extractor = new MarkableExtractor();
    expect(extractor.done).toBe(false);
    extractor.markComplete();
    expect(extractor.done).toBe(true);
  });

  it('should reset done to false after reset()', () => {
    const extractor = new MarkableExtractor();
    extractor.markComplete();
    expect(extractor.done).toBe(true);
    extractor.reset();
    expect(extractor.done).toBe(false);
  });

  it('should implement IStreamExtractor', () => {
    const extractor: IStreamExtractor = new MarkableExtractor();
    expect(typeof extractor.push).toBe('function');
    expect(typeof extractor.reset).toBe('function');
  });
});

// ============================================================================
// XmlTagExtractor
// ============================================================================

describe('XmlTagExtractor', () => {
  describe('basic functionality', () => {
    it('should extract content from specified tag', () => {
      const extractor = new XmlTagExtractor('text');
      const result = extractor.push('<response><text>Hello world!</text></response>');
      expect(result).toBe('Hello world!');
      expect(extractor.done).toBe(true);
    });

    it('should work with custom tag names', () => {
      const extractor = new XmlTagExtractor('message');
      const result = extractor.push('<response><message>Custom tag</message></response>');
      expect(result).toBe('Custom tag');
    });

    it('should ignore content outside target tag', () => {
      const extractor = new XmlTagExtractor('text');
      const result = extractor.push(
        '<response><other>ignored</other><text>extracted</text></response>'
      );
      expect(result).toBe('extracted');
    });
  });

  describe('streaming chunks', () => {
    it('should handle tag split across chunks', () => {
      const extractor = new XmlTagExtractor('text');
      const chunks: string[] = [];

      chunks.push(extractor.push('<response><te'));
      chunks.push(extractor.push('xt>Content</text></response>'));

      expect(chunks.join('')).toBe('Content');
      expect(extractor.done).toBe(true);
    });

    it('should stream content progressively', () => {
      const extractor = new XmlTagExtractor('text');
      const chunks: string[] = [];

      chunks.push(extractor.push('<text>'));
      chunks.push(extractor.push('Hello beautiful '));
      chunks.push(extractor.push('world! How are '));
      chunks.push(extractor.push('you today?'));
      chunks.push(extractor.push('</text>'));

      expect(chunks.join('')).toBe('Hello beautiful world! How are you today?');
    });

    it('should handle closing tag split across chunks', () => {
      const extractor = new XmlTagExtractor('text');
      const chunks: string[] = [];

      chunks.push(extractor.push('<text>Content</te'));
      chunks.push(extractor.push('xt>'));

      expect(chunks.join('')).toBe('Content');
    });
  });

  describe('edge cases', () => {
    it('should return empty when tag not found', () => {
      const extractor = new XmlTagExtractor('text');
      const result = extractor.push('<response><other>content</other></response>');
      expect(result).toBe('');
      expect(extractor.done).toBe(false);
    });

    it('should handle empty tag content', () => {
      const extractor = new XmlTagExtractor('text');
      const result = extractor.push('<text></text>');
      expect(result).toBe('');
      expect(extractor.done).toBe(true);
    });

    it('should not extract after done', () => {
      const extractor = new XmlTagExtractor('text');
      extractor.push('<text>First</text>');
      expect(extractor.done).toBe(true);

      const result = extractor.push('<text>Second</text>');
      expect(result).toBe('');
    });
  });
});

// ============================================================================
// ResponseStreamExtractor
// ============================================================================

describe('ResponseStreamExtractor', () => {
  describe('basic functionality', () => {
    it('should extract text content from complete XML', () => {
      const extractor = new ResponseStreamExtractor();
      const result = extractor.push(
        '<response><actions>REPLY</actions><text>Hello world!</text></response>'
      );

      expect(result).toBe('Hello world!');
      expect(extractor.done).toBe(true);
    });

    it('should return empty string when no streamable content', () => {
      const extractor = new ResponseStreamExtractor();
      const result = extractor.push('<response><thought>thinking</thought>');

      expect(result).toBe('');
      expect(extractor.done).toBe(false);
    });

    it('should reset properly', () => {
      const extractor = new ResponseStreamExtractor();

      extractor.push('<actions>REPLY</actions><text>First</text>');
      expect(extractor.done).toBe(true);

      extractor.reset();
      expect(extractor.done).toBe(false);

      const result = extractor.push('<actions>REPLY</actions><text>Second</text>');
      expect(result).toBe('Second');
      expect(extractor.done).toBe(true);
    });
  });

  describe('response strategy detection', () => {
    it('should stream <text> when action is REPLY (direct strategy)', () => {
      const extractor = new ResponseStreamExtractor();
      const result = extractor.push(
        '<response><actions>REPLY</actions><text>Direct response</text></response>'
      );

      expect(result).toBe('Direct response');
    });

    it('should NOT stream <text> when action is not REPLY (delegated strategy)', () => {
      const extractor = new ResponseStreamExtractor();
      const chunks: string[] = [];

      chunks.push(extractor.push('<response><actions>SEARCH</actions>'));
      chunks.push(extractor.push('<text>This should not stream</text></response>'));

      const fullText = chunks.join('');
      expect(fullText).toBe('');
    });

    it('should NOT stream <text> when multiple actions (delegated)', () => {
      const extractor = new ResponseStreamExtractor();
      const result = extractor.push(
        '<response><actions>REPLY,SEARCH</actions><text>Should not stream</text></response>'
      );

      expect(result).toBe('');
    });

    it('should NOT stream <text> when action is delegated (SEARCH)', () => {
      const extractor = new ResponseStreamExtractor();
      const result = extractor.push(
        '<response><actions>SEARCH</actions><text>Action handler message</text></response>'
      );

      // Delegated actions use ActionStreamFilter separately, not ResponseStreamExtractor
      expect(result).toBe('');
    });

    it('should handle case-insensitive action names', () => {
      const extractor = new ResponseStreamExtractor();
      const result = extractor.push(
        '<response><actions>reply</actions><text>Lowercase reply</text></response>'
      );

      expect(result).toBe('Lowercase reply');
    });

    it('should handle whitespace in actions tag', () => {
      const extractor = new ResponseStreamExtractor();
      const result = extractor.push(
        '<response><actions>  REPLY  </actions><text>Trimmed</text></response>'
      );

      expect(result).toBe('Trimmed');
    });
  });

  describe('streaming chunks', () => {
    it('should handle <text> tag split across chunks', () => {
      const extractor = new ResponseStreamExtractor();
      const chunks: string[] = [];

      chunks.push(extractor.push('<actions>REPLY</actions><te'));
      chunks.push(extractor.push('xt>Content here</text>'));

      const fullText = chunks.join('');
      expect(fullText).toBe('Content here');
      expect(extractor.done).toBe(true);
    });

    it('should handle </text> tag split across chunks', () => {
      const extractor = new ResponseStreamExtractor();
      const chunks: string[] = [];

      chunks.push(extractor.push('<actions>REPLY</actions><text>Hello'));
      chunks.push(extractor.push(' world</te'));
      chunks.push(extractor.push('xt>'));

      const fullText = chunks.join('');
      expect(fullText).toBe('Hello world');
      expect(extractor.done).toBe(true);
    });

    it('should stream content incrementally for long text', () => {
      const extractor = new ResponseStreamExtractor();
      const chunks: string[] = [];

      chunks.push(extractor.push('<actions>REPLY</actions><text>'));
      chunks.push(extractor.push('Hello beautiful '));
      chunks.push(extractor.push('world! How are '));
      chunks.push(extractor.push('you today?'));
      chunks.push(extractor.push('</text>'));

      const fullText = chunks.join('');
      expect(fullText).toBe('Hello beautiful world! How are you today?');
      expect(extractor.done).toBe(true);
    });

    it('should handle large content before <text> tag without memory issues', () => {
      const extractor = new ResponseStreamExtractor();

      const largeThought = 'a'.repeat(150 * 1024); // 150KB
      let result = extractor.push(`<actions>REPLY</actions><thought>${largeThought}</thought>`);
      expect(result).toBe('');
      expect(extractor.done).toBe(false);

      result = extractor.push('<text>Finally some text</text>');
      expect(result).toBe('Finally some text');
      expect(extractor.done).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should return empty string after done', () => {
      const extractor = new ResponseStreamExtractor();

      extractor.push('<actions>REPLY</actions><text>Hello</text>');
      expect(extractor.done).toBe(true);

      const result = extractor.push('more content');
      expect(result).toBe('');
    });

    it('should handle empty text content', () => {
      const extractor = new ResponseStreamExtractor();

      const result = extractor.push('<actions>REPLY</actions><text></text>');
      expect(result).toBe('');
      expect(extractor.done).toBe(true);
    });

    it('should handle newlines in text content', () => {
      const extractor = new ResponseStreamExtractor();

      const result = extractor.push('<actions>REPLY</actions><text>Line 1\nLine 2\nLine 3</text>');
      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should handle special characters in text content', () => {
      const extractor = new ResponseStreamExtractor();

      const result = extractor.push(
        '<actions>REPLY</actions><text>Special: &lt;tag&gt; &amp; "quotes"</text>'
      );
      expect(result).toBe('Special: &lt;tag&gt; &amp; "quotes"');
    });

    it('should wait for actions before deciding strategy', () => {
      const extractor = new ResponseStreamExtractor();
      const chunks: string[] = [];

      // Text comes before actions are known
      chunks.push(extractor.push('<response><text>Early text'));
      chunks.push(extractor.push('</text><actions>SEARCH</actions></response>'));

      // Since actions were determined after text started, behavior depends on implementation
      // Currently, pending strategy treats text as not streamable until decided
      expect(extractor.done).toBe(false); // Text was skipped
    });
  });
});

describe('ActionStreamFilter', () => {
  describe('content type detection', () => {
    it('should detect JSON from first character {', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('{"key": "value"}');

      expect(result).toBe(''); // JSON is never streamed
    });

    it('should detect JSON array from first character [', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('[1, 2, 3]');

      expect(result).toBe(''); // JSON is never streamed
    });

    it('should detect XML from first character <', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('<response><text>Hello</text></response>');

      expect(result).toBe('Hello');
    });

    it('should detect plain text and stream immediately', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('Hello world!');

      expect(result).toBe('Hello world!');
    });

    it('should handle leading whitespace before detection', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('   Hello world!');

      expect(result).toBe('   Hello world!'); // Whitespace included in output
    });

    it('should handle leading whitespace before JSON', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('   {"key": "value"}');

      expect(result).toBe(''); // JSON detected after whitespace, not streamed
    });
  });

  describe('JSON handling', () => {
    it('should never stream JSON objects', () => {
      const filter = new ActionStreamFilter();
      const chunks: string[] = [];

      chunks.push(filter.push('{"name":'));
      chunks.push(filter.push(' "test",'));
      chunks.push(filter.push(' "value": 123}'));

      const fullText = chunks.join('');
      expect(fullText).toBe('');
    });

    it('should never stream JSON arrays', () => {
      const filter = new ActionStreamFilter();
      const chunks: string[] = [];

      chunks.push(filter.push('['));
      chunks.push(filter.push('"item1",'));
      chunks.push(filter.push(' "item2"]'));

      const fullText = chunks.join('');
      expect(fullText).toBe('');
    });
  });

  describe('XML handling', () => {
    it('should extract <text> tag content from XML', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('<response><text>Action result</text></response>');

      expect(result).toBe('Action result');
      expect(filter.done).toBe(true);
    });

    it('should ignore XML without <text> tag', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('<response><data>Some data</data></response>');

      expect(result).toBe('');
      expect(filter.done).toBe(false);
    });

    it('should handle <text> tag split across chunks', () => {
      const filter = new ActionStreamFilter();
      const chunks: string[] = [];

      chunks.push(filter.push('<response><te'));
      chunks.push(filter.push('xt>Content</text></response>'));

      const fullText = chunks.join('');
      expect(fullText).toBe('Content');
      expect(filter.done).toBe(true);
    });

    it('should stream text content incrementally', () => {
      const filter = new ActionStreamFilter();
      const chunks: string[] = [];

      chunks.push(filter.push('<response><text>Part 1 '));
      chunks.push(filter.push('Part 2 '));
      chunks.push(filter.push('Part 3'));
      chunks.push(filter.push('</text></response>'));

      const fullText = chunks.join('');
      expect(fullText).toBe('Part 1 Part 2 Part 3');
      expect(filter.done).toBe(true);
    });
  });

  describe('plain text handling', () => {
    it('should stream plain text immediately', () => {
      const filter = new ActionStreamFilter();
      const chunks: string[] = [];

      chunks.push(filter.push('Hello '));
      chunks.push(filter.push('world '));
      chunks.push(filter.push('!'));

      const fullText = chunks.join('');
      expect(fullText).toBe('Hello world !');
    });

    it('should stream text starting with letters', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('The quick brown fox');

      expect(result).toBe('The quick brown fox');
    });

    it('should stream text starting with numbers', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('123 is a number');

      expect(result).toBe('123 is a number');
    });
  });

  describe('reset and reuse', () => {
    it('should reset properly', () => {
      const filter = new ActionStreamFilter();

      filter.push('{"json": true}');
      filter.reset();

      const result = filter.push('plain text');
      expect(result).toBe('plain text');
    });

    it('should handle multiple uses after reset', () => {
      const filter = new ActionStreamFilter();

      // First use: JSON
      filter.push('{"a": 1}');
      expect(filter.done).toBe(false);

      // Reset and use for XML
      filter.reset();
      filter.push('<r><text>Msg</text></r>');
      expect(filter.done).toBe(true);

      // Reset and use for text
      filter.reset();
      const result = filter.push('Hello');
      expect(result).toBe('Hello');
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('');

      expect(result).toBe('');
    });

    it('should handle only whitespace', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('   ');

      expect(result).toBe(''); // Not decided yet, waiting for actual content
    });

    it('should handle large XML without text tag efficiently', () => {
      const filter = new ActionStreamFilter();

      const largeXml = `<response><data>${'a'.repeat(100 * 1024)}</data></response>`;
      const result = filter.push(largeXml);

      expect(result).toBe(''); // No text tag, nothing streamed
    });
  });
});

// ============================================================================
// ValidationStreamExtractor - Validation-aware streaming
// ============================================================================

describe('ValidationStreamExtractor', () => {
  const createSchema = (): SchemaRow[] => [
    { field: 'thought', description: 'Internal reasoning' },
    { field: 'text', description: 'Response text', required: true },
    { field: 'actions', description: 'Actions to take' },
  ];

  describe('interface conformance', () => {
    it('implements IStreamExtractor', () => {
      const extractor: IStreamExtractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: () => {},
      });
      expect(extractor.done).toBe(false);
      expect(typeof extractor.push).toBe('function');
    });
  });

  describe('level 0 - trusted (no validation codes)', () => {
    it('should emit text immediately without validation codes', () => {
      const chunks: string[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: (chunk) => chunks.push(chunk),
      });

      extractor.push('<response><text>Hello world!</text></response>');
      expect(chunks.join('')).toBe('Hello world!');
    });

    it('should stream incrementally', () => {
      const chunks: string[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: (chunk) => chunks.push(chunk),
      });

      extractor.push('<response><text>Hello ');
      extractor.push('beautiful ');
      extractor.push('world!</text></response>');

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join('')).toBe('Hello beautiful world!');
    });

    it('should respect validateField opt-in', () => {
      const chunks: string[] = [];
      const schema: SchemaRow[] = [
        { field: 'text', description: 'Response', validateField: true },
      ];
      const expectedCodes = new Map([['text', 'abc123']]);

      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema,
        streamFields: ['text'],
        expectedCodes,
        onChunk: (chunk) => chunks.push(chunk),
      });

      // Without codes - should not emit
      extractor.push('<response><text>Hello</text></response>');
      expect(chunks.length).toBe(0);

      // With valid codes - should emit
      extractor.reset();
      extractor.push('<response><code_text_start>abc123</code_text_start><text>Hello</text><code_text_end>abc123</code_text_end></response>');
      expect(chunks.join('')).toBe('Hello');
    });
  });

  describe('level 1 - progressive (per-field codes)', () => {
    it('should wait for validation codes before emitting', () => {
      const chunks: string[] = [];
      const events: StreamEvent[] = [];
      const expectedCodes = new Map([['text', 'abc123']]);

      const extractor = new ValidationStreamExtractor({
        level: 1,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes,
        onChunk: (chunk) => chunks.push(chunk),
        onEvent: (event) => events.push(event),
      });

      // Without codes - should not emit
      extractor.push('<response><text>Hello world!</text></response>');
      expect(chunks.length).toBe(0);
    });

    it('should emit after valid codes are found', () => {
      const chunks: string[] = [];
      const events: StreamEvent[] = [];
      const expectedCodes = new Map([['text', 'abc123']]);

      const extractor = new ValidationStreamExtractor({
        level: 1,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes,
        onChunk: (chunk) => chunks.push(chunk),
        onEvent: (event) => events.push(event),
      });

      extractor.push(
        '<response>' +
        '<code_text_start>abc123</code_text_start>' +
        '<text>Hello world!</text>' +
        '<code_text_end>abc123</code_text_end>' +
        '</response>'
      );

      expect(chunks.join('')).toBe('Hello world!');
      expect(events.some(e => e.type === 'field_validated')).toBe(true);
    });

    it('should respect validateField opt-out', () => {
      const chunks: string[] = [];
      const schema: SchemaRow[] = [
        { field: 'text', description: 'Response', validateField: false },
      ];
      const expectedCodes = new Map<string, string>();

      const extractor = new ValidationStreamExtractor({
        level: 1,
        schema,
        streamFields: ['text'],
        expectedCodes,
        onChunk: (chunk) => chunks.push(chunk),
      });

      // With validateField: false, should emit immediately even at level 1
      extractor.push('<response><text>Hello world!</text></response>');
      expect(chunks.join('')).toBe('Hello world!');
    });

    it('should emit error event on invalid start code', () => {
      const chunks: string[] = [];
      const events: StreamEvent[] = [];
      const expectedCodes = new Map([['text', 'abc123']]);

      const extractor = new ValidationStreamExtractor({
        level: 1,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes,
        onChunk: (chunk) => chunks.push(chunk),
        onEvent: (event) => events.push(event),
      });

      extractor.push(
        '<response>' +
        '<code_text_start>wrong_code</code_text_start>' +
        '<text>Hello</text>' +
        '<code_text_end>abc123</code_text_end>' +
        '</response>'
      );

      expect(chunks.length).toBe(0);
      expect(events.some(e => e.type === 'error' && e.error?.includes('start code'))).toBe(true);
    });

    it('should emit error event on invalid end code', () => {
      const chunks: string[] = [];
      const events: StreamEvent[] = [];
      const expectedCodes = new Map([['text', 'abc123']]);

      const extractor = new ValidationStreamExtractor({
        level: 1,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes,
        onChunk: (chunk) => chunks.push(chunk),
        onEvent: (event) => events.push(event),
      });

      // Start code is correct, but end code is wrong
      extractor.push(
        '<response>' +
        '<code_text_start>abc123</code_text_start>' +
        '<text>Hello</text>' +
        '<code_text_end>wrong_code</code_text_end>' +
        '</response>'
      );

      // Should NOT emit text since end code is invalid
      expect(chunks.length).toBe(0);
      // Should emit error event for invalid end code
      expect(events.some(e => e.type === 'error' && e.error?.includes('end code'))).toBe(true);
    });
  });

  describe('level 2-3 - buffered (checkpoint codes)', () => {
    it('should buffer content until flush is called', () => {
      const chunks: string[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 2,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: (chunk) => chunks.push(chunk),
      });

      extractor.push('<response><text>Hello world!</text></response>');
      expect(chunks.length).toBe(0);

      extractor.flush();
      expect(chunks.join('')).toBe('Hello world!');
    });

    it('should emit complete event on flush', () => {
      const events: StreamEvent[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 3,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: () => {},
        onEvent: (event) => events.push(event),
      });

      extractor.push('<response><text>Hello</text></response>');
      extractor.flush();

      expect(events.some(e => e.type === 'complete')).toBe(true);
    });
  });

  describe('signalRetry', () => {
    it('should emit retry_start event', () => {
      const events: StreamEvent[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 1,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map([['text', 'abc']]),
        onChunk: () => {},
        onEvent: (event) => events.push(event),
        hasRichConsumer: true,
      });

      extractor.push('<response><text>Partial</text></response>');
      extractor.signalRetry(1);

      expect(events.some(e => e.type === 'retry_start' && e.retryCount === 1)).toBe(true);
    });

    it('should emit separator for simple consumers', () => {
      const chunks: string[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: (chunk) => chunks.push(chunk),
        hasRichConsumer: false,
      });

      extractor.push('<response><text>Hello</text></response>');
      extractor.signalRetry(1);

      expect(chunks.some(c => c.includes("that's not right"))).toBe(true);
    });

    it('should NOT emit separator for rich consumers', () => {
      const chunks: string[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: (chunk) => chunks.push(chunk),
        hasRichConsumer: true,
      });

      extractor.push('<response><text>Hello</text></response>');
      extractor.signalRetry(1);

      expect(chunks.every(c => !c.includes("that's not right"))).toBe(true);
    });
  });

  describe('signalError', () => {
    it('should emit error event', () => {
      const events: StreamEvent[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: () => {},
        onEvent: (event) => events.push(event),
      });

      extractor.signalError('Max retries exceeded');

      expect(events.some(e => e.type === 'error' && e.error === 'Max retries exceeded')).toBe(true);
      expect(extractor.getState()).toBe('failed');
    });
  });

  describe('diagnose', () => {
    it('should identify missing fields', () => {
      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text', 'actions'],
        expectedCodes: new Map(),
        onChunk: () => {},
      });

      extractor.push('<response><thought>Thinking</thought></response>');
      const diagnosis = extractor.diagnose();

      expect(diagnosis.missingFields).toContain('text');
      expect(diagnosis.missingFields).toContain('actions');
    });

    it('should identify incomplete fields', () => {
      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: () => {},
      });

      // Partial text tag (not closed)
      extractor.push('<response><text>Hello ');
      const diagnosis = extractor.diagnose();

      expect(diagnosis.incompleteFields).toContain('text');
    });
  });

  describe('cancellation', () => {
    it('should stop processing when aborted', () => {
      const chunks: string[] = [];
      const events: StreamEvent[] = [];
      const abortController = new AbortController();

      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: (chunk) => chunks.push(chunk),
        onEvent: (event) => events.push(event),
        abortSignal: abortController.signal,
      });

      extractor.push('<response><text>Hello</text></response>');
      abortController.abort();
      extractor.push('<response><text>World</text></response>');

      // Should have stopped after abort
      expect(events.some(e => e.type === 'error' && e.error?.includes('Cancelled'))).toBe(true);
      expect(extractor.getState()).toBe('failed');
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      const chunks: string[] = [];
      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes: new Map(),
        onChunk: (chunk) => chunks.push(chunk),
      });

      extractor.push('<response><text>First</text></response>');
      expect(extractor.hasEmittedContent()).toBe(true);

      extractor.reset();
      expect(extractor.hasEmittedContent()).toBe(false);
      expect(extractor.getState()).toBe('streaming');

      extractor.push('<response><text>Second</text></response>');
      expect(chunks.join('')).toContain('Second');
    });
  });

  describe('getValidatedFields', () => {
    it('should return validated field contents for level 1', () => {
      const expectedCodes = new Map([['text', 'abc123']]);

      const extractor = new ValidationStreamExtractor({
        level: 1,
        schema: createSchema(),
        streamFields: ['text'],
        expectedCodes,
        onChunk: () => {},
      });

      extractor.push(
        '<response>' +
        '<code_text_start>abc123</code_text_start>' +
        '<text>Hello world!</text>' +
        '<code_text_end>abc123</code_text_end>' +
        '</response>'
      );

      const validated = extractor.getValidatedFields();
      expect(validated.get('text')).toBe('Hello world!');
    });
  });

  describe('streamField hints', () => {
    it('should only stream fields with streamField: true', () => {
      const chunks: string[] = [];
      const schema: SchemaRow[] = [
        { field: 'thought', description: 'Internal reasoning', streamField: false },
        { field: 'text', description: 'Response', streamField: true },
        { field: 'actions', description: 'Actions to take' }, // default: false (not 'text')
      ];

      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema,
        streamFields: ['text'], // Only stream text
        expectedCodes: new Map(),
        onChunk: (chunk) => chunks.push(chunk),
      });

      extractor.push('<response><thought>Thinking...</thought><text>Hello!</text><actions>REPLY</actions></response>');

      // Only text should be streamed
      expect(chunks.join('')).toBe('Hello!');
      expect(chunks.join('')).not.toContain('Thinking');
      expect(chunks.join('')).not.toContain('REPLY');
    });

    it('should stream multiple fields when specified', () => {
      const chunks: { content: string; field?: string }[] = [];
      const schema: SchemaRow[] = [
        { field: 'summary', description: 'Summary', streamField: true },
        { field: 'details', description: 'Details', streamField: true },
        { field: 'metadata', description: 'Metadata', streamField: false },
      ];

      const extractor = new ValidationStreamExtractor({
        level: 0,
        schema,
        streamFields: ['summary', 'details'],
        expectedCodes: new Map(),
        onChunk: (chunk, field) => chunks.push({ content: chunk, field }),
      });

      extractor.push('<response><summary>TL;DR</summary><details>Full details here</details><metadata>hidden</metadata></response>');

      const streamed = chunks.map((c) => c.content).join('');
      expect(streamed).toContain('TL;DR');
      expect(streamed).toContain('Full details here');
      expect(streamed).not.toContain('hidden');
    });
  });
});
