/**
 * Tests for XML parser utility
 * Verifies robust handling of LLM responses with reasoning text
 */

import { describe, expect, test } from 'bun:test';
import { cleanXMLMarkdown, extractXMLFromText, parseXML } from '../xml-parser';

describe('XMLParser', () => {
  describe('extractXMLFromText', () => {
    test('should extract XML from clean input', () => {
      const input = '<decisions><decision>test</decision></decisions>';
      const result = extractXMLFromText(input);

      expect(result).toBe(input);
    });

    test('should extract XML when preceded by reasoning text', () => {
      const input = `Okay, let's see. I need to decide what to do here. Let me think about this carefully.

<decisions>
  <decision>
    <npcId>1</npcId>
    <action>hold</action>
  </decision>
</decisions>`;

      const result = extractXMLFromText(input);

      expect(result).toContain('<decisions>');
      expect(result).toContain('</decisions>');
      expect(result).not.toContain("Okay, let's see");
    });

    test('should extract XML when followed by reasoning text', () => {
      const input = `<decisions>
  <decision>
    <npcId>1</npcId>
    <action>hold</action>
  </decision>
</decisions>

And that's my reasoning for this decision.`;

      const result = extractXMLFromText(input);

      expect(result).toContain('<decisions>');
      expect(result).toContain('</decisions>');
      expect(result).not.toContain('reasoning for this decision');
    });

    test('should extract XML from middle of text', () => {
      const input = `Let me analyze this carefully.

<decisions>
  <decision><npcId>1</npcId><action>hold</action></decision>
</decisions>

That should work!`;

      const result = extractXMLFromText(input);

      expect(result).toContain('<decisions>');
      expect(result).toContain('</decisions>');
      expect(result).not.toContain('Let me analyze');
      expect(result).not.toContain('That should work');
    });

    test('should handle response/result tags', () => {
      const input = `Here is the response:
<response>
  <item>test</item>
</response>`;

      const result = extractXMLFromText(input);

      expect(result).toContain('<response>');
      expect(result).toContain('</response>');
      expect(result).not.toContain('Here is the response');
    });

    test('should extract generic XML tags as fallback', () => {
      const input = `Thinking out loud...
<mydata>
  <field>value</field>
</mydata>`;

      const result = extractXMLFromText(input);

      expect(result).toContain('<mydata>');
      expect(result).toContain('</mydata>');
    });

    test('should handle malformed extraction gracefully', () => {
      const input = 'Just plain text with no XML';
      const result = extractXMLFromText(input);

      // Should return original if no XML found
      expect(result).toBe(input);
    });
  });

  describe('cleanXMLMarkdown', () => {
    test('should remove markdown code fences', () => {
      const input = '```xml\n<data>test</data>\n```';
      const result = cleanXMLMarkdown(input);

      expect(result).toBe('<data>test</data>');
    });

    test('should remove generic code fences', () => {
      const input = '```\n<data>test</data>\n```';
      const result = cleanXMLMarkdown(input);

      expect(result).toBe('<data>test</data>');
    });

    test('should trim whitespace', () => {
      const input = '  \n  <data>test</data>  \n  ';
      const result = cleanXMLMarkdown(input);

      expect(result).toBe('<data>test</data>');
    });
  });

  describe('parseXML', () => {
    test('should parse valid XML', () => {
      const xml =
        '<decisions><decision><npcId>1</npcId><action>hold</action></decision></decisions>';
      const result = parseXML(xml);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test('should parse XML with reasoning prefix', () => {
      const xml = `Okay, let me think about this carefully.

<decisions>
  <decision>
    <npcId>alice</npcId>
    <action>hold</action>
  </decision>
</decisions>`;

      const result = parseXML(xml);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test('should fallback to JSON if LLM returns JSON instead', () => {
      const json = '{"decisions": [{"npcId": "1", "action": "hold"}]}';
      const result = parseXML(json);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test('should handle nested XML structures', () => {
      const xml = `<decisions>
  <decision>
    <npcId>1</npcId>
    <details>
      <field1>value1</field1>
      <field2>value2</field2>
    </details>
  </decision>
</decisions>`;

      const result = parseXML(xml);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test('should handle markdown-wrapped XML', () => {
      const xml =
        '```xml\n<decisions><decision><npcId>1</npcId></decision></decisions>\n```';
      const result = parseXML(xml);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test('should return error for completely invalid input', () => {
      const invalid = 'This is just plain text with no structure at all';
      const result = parseXML(invalid);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should handle array of decisions', () => {
      const xml = `<decisions>
  <decision><npcId>1</npcId><action>hold</action></decision>
  <decision><npcId>2</npcId><action>buy_yes</action></decision>
  <decision><npcId>3</npcId><action>open_long</action></decision>
</decisions>`;

      const result = parseXML(xml);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      // The parser should recognize multiple <decision> tags as an array
      const data = result.data as Record<string, unknown>;
      expect(data.decision).toBeDefined();
      expect(Array.isArray(data.decision)).toBe(true);
    });
  });
});
