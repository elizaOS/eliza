import { describe, expect, it } from 'bun:test';
import { ResponseStreamExtractor, ActionStreamFilter } from '../../utils/streaming';

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

    it('should stream <message> tag regardless of strategy', () => {
      const extractor = new ResponseStreamExtractor();
      const result = extractor.push(
        '<response><actions>SEARCH</actions><message>Action handler message</message></response>'
      );

      expect(result).toBe('Action handler message');
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

      const result = extractor.push(
        '<actions>REPLY</actions><text>Line 1\nLine 2\nLine 3</text>'
      );
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
      const result = filter.push('<response><message>Hello</message></response>');

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
    it('should extract <message> tag content from XML', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('<response><message>Action result</message></response>');

      expect(result).toBe('Action result');
      expect(filter.done).toBe(true);
    });

    it('should ignore XML without <message> tag', () => {
      const filter = new ActionStreamFilter();
      const result = filter.push('<response><data>Some data</data></response>');

      expect(result).toBe('');
      expect(filter.done).toBe(false);
    });

    it('should handle <message> tag split across chunks', () => {
      const filter = new ActionStreamFilter();
      const chunks: string[] = [];

      chunks.push(filter.push('<response><mes'));
      chunks.push(filter.push('sage>Content</message></response>'));

      const fullText = chunks.join('');
      expect(fullText).toBe('Content');
      expect(filter.done).toBe(true);
    });

    it('should stream message content incrementally', () => {
      const filter = new ActionStreamFilter();
      const chunks: string[] = [];

      chunks.push(filter.push('<response><message>Part 1 '));
      chunks.push(filter.push('Part 2 '));
      chunks.push(filter.push('Part 3'));
      chunks.push(filter.push('</message></response>'));

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
      filter.push('<r><message>Msg</message></r>');
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

    it('should handle large XML without message tag efficiently', () => {
      const filter = new ActionStreamFilter();

      const largeXml = `<response><data>${'a'.repeat(100 * 1024)}</data></response>`;
      const result = filter.push(largeXml);

      expect(result).toBe(''); // No message tag, nothing streamed
    });
  });
});
