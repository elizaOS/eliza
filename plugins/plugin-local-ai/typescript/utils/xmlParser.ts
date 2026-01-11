/**
 * Robust XML parser utilities for handling model responses
 *
 * Handles edge cases like:
 * - Code blocks that contain XML-like syntax
 * - CDATA sections
 * - Nested tags
 * - Malformed XML
 */

import { logger } from "@elizaos/core";

/**
 * Extract content from an XML tag, handling CDATA sections and nested tags
 */
export function extractXmlTag(text: string, tagName: string): string | null {
  if (!text || !tagName) return null;

  // First, try to find CDATA content
  const cdataPattern = new RegExp(
    `<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`,
    "i"
  );
  const cdataMatch = text.match(cdataPattern);
  if (cdataMatch) {
    return cdataMatch[1];
  }

  // Handle regular content with proper nesting using linear scanning
  const startTagPattern = `<${tagName}`;
  const endTag = `</${tagName}>`;

  const startIdx = text.indexOf(startTagPattern);
  if (startIdx === -1) return null;

  // Find the end of the start tag (handle attributes)
  const startTagEnd = text.indexOf(">", startIdx);
  if (startTagEnd === -1) return null;

  // Check for self-closing tag
  if (text.slice(startIdx, startTagEnd + 1).includes("/>")) {
    return "";
  }

  const contentStart = startTagEnd + 1;

  // Use depth counting to handle nested same-name tags
  let depth = 1;
  let searchStart = contentStart;

  while (depth > 0 && searchStart < text.length) {
    const nextOpen = text.indexOf(startTagPattern, searchStart);
    const nextClose = text.indexOf(endTag, searchStart);

    if (nextClose === -1) {
      // No closing tag found
      break;
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Check if this is a start tag (not self-closing)
      const nestedEndIdx = text.indexOf(">", nextOpen);
      if (nestedEndIdx !== -1) {
        const nestedTagContent = text.slice(nextOpen, nestedEndIdx + 1);
        if (!nestedTagContent.includes("/>")) {
          depth++;
        }
      }
      searchStart = nestedEndIdx !== -1 ? nestedEndIdx + 1 : nextOpen + 1;
    } else {
      depth--;
      if (depth === 0) {
        const content = text.slice(contentStart, nextClose);
        return unescapeXml(content.trim());
      }
      searchStart = nextClose + endTag.length;
    }
  }

  return null;
}

/**
 * Unescape common XML entities
 */
export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Escape text for safe inclusion in XML
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Wrap content in CDATA section if it contains special characters
 */
export function wrapInCdata(text: string): string {
  if (text.includes("<") || text.includes(">") || text.includes("&")) {
    // Handle nested CDATA by escaping the closing sequence
    const escapedText = text.replace(/\]\]>/g, "]]]]><![CDATA[>");
    return `<![CDATA[${escapedText}]]>`;
  }
  return text;
}

/**
 * Parse a simple key-value XML structure into an object
 * More robust than regex-based parsing
 */
export function parseSimpleXml<T = Record<string, unknown>>(text: string): T | null {
  if (!text) return null;

  // Find the response block
  let xmlContent = extractXmlTag(text, "response");

  // If no response block, try to find any XML-like structure
  if (!xmlContent) {
    // Look for common wrapper tags
    for (const wrapper of ["result", "output", "data", "answer"]) {
      xmlContent = extractXmlTag(text, wrapper);
      if (xmlContent) break;
    }
  }

  // If still no XML content, try to parse the text directly
  if (!xmlContent) {
    // Check if the text looks like it has XML tags
    if (!text.includes("<") || !text.includes(">")) {
      logger.debug("No XML-like content found in text");
      return null;
    }
    xmlContent = text;
  }

  const result: Record<string, unknown> = {};

  // Extract all top-level tags
  const tagPattern = /<([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>/g;
  const foundTags = new Set<string>();

  let match: RegExpExecArray | null = tagPattern.exec(xmlContent);
  while (match !== null) {
    const tagName = match[1];
    // Skip if we've already processed this tag
    if (foundTags.has(tagName)) continue;
    foundTags.add(tagName);

    const value = extractXmlTag(xmlContent, tagName);
    if (value !== null) {
      // Handle special cases
      if (tagName === "actions" || tagName === "providers" || tagName === "evaluators") {
        // Parse comma-separated lists
        result[tagName] = value
          ? value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      } else if (tagName === "simple" || tagName === "success" || tagName === "error") {
        // Parse boolean values
        result[tagName] = value.toLowerCase() === "true";
      } else {
        result[tagName] = value;
      }
    }
    match = tagPattern.exec(xmlContent);
  }

  if (Object.keys(result).length === 0) {
    logger.debug("No key-value pairs extracted from XML content");
    return null;
  }

  return result as T;
}

/**
 * Sanitize user content for safe XML inclusion
 * Handles code blocks and other potentially problematic content
 */
export function sanitizeForXml(content: string): string {
  // Check if content contains XML-like syntax that could cause parsing issues
  const hasXmlLikeSyntax = /<[a-zA-Z]/.test(content) || content.includes("</");

  if (hasXmlLikeSyntax) {
    // Wrap in CDATA to preserve the content exactly
    return wrapInCdata(content);
  }

  // Otherwise, just escape special characters
  return escapeXml(content);
}

/**
 * Build an XML response string from an object
 */
export function buildXmlResponse(data: Record<string, unknown>): string {
  const parts: string[] = ["<response>"];

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      // Join array values with commas
      parts.push(`  <${key}>${value.join(", ")}</${key}>`);
    } else if (typeof value === "boolean") {
      parts.push(`  <${key}>${value}</${key}>`);
    } else if (typeof value === "string") {
      // Check if the string needs CDATA wrapping
      const content = sanitizeForXml(value);
      parts.push(`  <${key}>${content}</${key}>`);
    } else if (typeof value === "object") {
      // Nested object - serialize recursively
      const nested = buildXmlResponse(value as Record<string, unknown>);
      // Strip outer response tags and indent
      const innerContent = nested
        .replace(/^<response>\n?/, "")
        .replace(/\n?<\/response>$/, "")
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      parts.push(`  <${key}>\n${innerContent}\n  </${key}>`);
    } else {
      parts.push(`  <${key}>${String(value)}</${key}>`);
    }
  }

  parts.push("</response>");
  return parts.join("\n");
}

// =============================================================================
// Self-test function - run with: bun run typescript/utils/xmlParser.ts
// =============================================================================
if (import.meta.main) {
  const tests: Array<{ name: string; fn: () => void }> = [];
  const test = (name: string, fn: () => void) => tests.push({ name, fn });
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  test("extract_simple_tag", () => {
    const xml = "<response><name>John</name></response>";
    assert(extractXmlTag(xml, "name") === "John", "Expected John");
  });

  test("extract_cdata", () => {
    const xml = "<response><code><![CDATA[<script>alert('hello')</script>]]></code></response>";
    assert(
      extractXmlTag(xml, "code") === "<script>alert('hello')</script>",
      "CDATA extraction failed"
    );
  });

  test("extract_nested_tags", () => {
    const xml = "<response><outer><inner>value</inner></outer></response>";
    const outer = extractXmlTag(xml, "outer");
    assert(outer?.includes("<inner>value</inner>"), "Nested extraction failed");
  });

  test("escape_xml", () => {
    assert(escapeXml("<test>") === "&lt;test&gt;", "Escape failed");
  });

  test("unescape_xml", () => {
    assert(unescapeXml("&lt;test&gt;") === "<test>", "Unescape failed");
  });

  test("unescape_numeric_entities", () => {
    assert(unescapeXml("&#60;") === "<", "Decimal entity failed");
    assert(unescapeXml("&#62;") === ">", "Decimal entity failed");
    assert(unescapeXml("&#x3C;") === "<", "Hex entity failed");
    assert(unescapeXml("&#x3E;") === ">", "Hex entity failed");
    assert(unescapeXml("&#60;test&#62;") === "<test>", "Combined entity failed");
  });

  test("wrap_in_cdata", () => {
    assert(wrapInCdata("<code>") === "<![CDATA[<code>]]>", "CDATA wrap failed");
    assert(wrapInCdata("plain text") === "plain text", "Plain text should not be wrapped");
  });

  test("wrap_nested_cdata", () => {
    assert(
      wrapInCdata("data]]>more") === "<![CDATA[data]]]]><![CDATA[>more]]>",
      "Nested CDATA escape failed"
    );
  });

  test("parse_simple_xml", () => {
    const xml = "<response><thought>thinking...</thought><text>Hello world</text></response>";
    const result = parseSimpleXml<{ thought: string; text: string }>(xml);
    assert(result !== null, "Parse returned null");
    assert(result.thought === "thinking...", "Thought mismatch");
    assert(result.text === "Hello world", "Text mismatch");
  });

  test("parse_list_fields", () => {
    const xml = "<response><actions>action1, action2, action3</actions></response>";
    const result = parseSimpleXml<{ actions: string[] }>(xml);
    assert(result !== null, "Parse returned null");
    const actions = result.actions;
    assert(Array.isArray(actions), "Actions should be array");
    assert(actions.length === 3, "Expected 3 actions");
    assert(actions[0] === "action1", "First action mismatch");
  });

  test("parse_boolean_fields", () => {
    const xml = "<response><success>true</success><error>false</error></response>";
    const result = parseSimpleXml<{ success: boolean; error: boolean }>(xml);
    assert(result !== null, "Parse returned null");
    assert(result.success === true, "Success should be true");
    assert(result.error === false, "Error should be false");
  });

  test("self_closing_tag", () => {
    const xml = "<response><empty/></response>";
    assert(extractXmlTag(xml, "empty") === "", "Self-closing should return empty string");
  });

  test("code_in_cdata", () => {
    const xml = `<response>
<code><![CDATA[
function test() {
    if (x < 10 && y > 5) {
        return "<div>" + x + "</div>";
    }
}
]]></code>
</response>`;
    const code = extractXmlTag(xml, "code");
    assert(code !== null, "Code extraction returned null");
    assert(code.includes("if (x < 10 && y > 5)"), "Code content missing");
    assert(code.includes("<div>"), "HTML in code missing");
  });

  // Run all tests
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${name}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\n${passed}/${passed + failed} tests passed`);
  if (failed > 0) process.exit(1);
}
