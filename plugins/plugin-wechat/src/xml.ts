/**
 * Hardened XML support for first-party WeChat platform callbacks. WeChat's MP
 * and WeCom message XML is strictly flat (a root element whose children are
 * all leaf text nodes), so this module implements exactly that subset with a
 * hand-rolled parser that rejects DTDs, entity declarations, CDATA tricks,
 * comments, processing instructions, nesting, duplicate roots, and oversized
 * inputs — none of which legitimate WeChat payloads ever contain. Parsing
 * happens only after signature verification.
 */
import { WechatError } from "./types";

export const MAX_XML_BYTES = 64 * 1024;

export type XmlObject = Record<string, string>;

export interface ParsedXml {
  root: string;
  fields: XmlObject;
}

/** Parse one flat XML document into `{ root, fields }`. */
export function parseWechatXml(
  input: string | Buffer,
  options?: { maxBytes?: number },
): ParsedXml {
  const maxBytes = options?.maxBytes ?? MAX_XML_BYTES;
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;

  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new WechatError(
      "WECHAT_CALLBACK_MALFORMED",
      "callback XML exceeds size limit",
      { maxBytes },
    );
  }

  const trimmed = text.trim();
  // A lone "<?xml ...?>" declaration is permitted ahead of the root element.
  const withoutDecl = trimmed.startsWith("<?xml")
    ? trimmed.replace(/^<\?xml[^>]*\?>/, "").trim()
    : trimmed;

  const rootMatch = /^<([A-Za-z][A-Za-z0-9_.-]*)>/.exec(withoutDecl);
  if (!rootMatch) {
    throw new WechatError(
      "WECHAT_CALLBACK_MALFORMED",
      "callback XML has no root element",
    );
  }
  const root = rootMatch[1];

  const closingIndex = withoutDecl.indexOf(`</${root}>`);
  if (closingIndex < 0) {
    throw new WechatError(
      "WECHAT_CALLBACK_MALFORMED",
      "callback XML root element is not closed",
      { root },
    );
  }

  const inner = withoutDecl.slice(rootMatch[0].length, closingIndex);
  // Nothing may follow the root's closing tag (no sibling roots, no trailing junk).
  const after = withoutDecl.slice(closingIndex + root.length + 3).trim();
  if (after.length > 0) {
    throw new WechatError(
      "WECHAT_CALLBACK_MALFORMED",
      "callback XML has trailing content after root",
    );
  }

  const fields: XmlObject = {};
  let cursor = 0;
  while (cursor < inner.length) {
    if (inner.startsWith("<![CDATA[", cursor)) {
      throw new WechatError(
        "WECHAT_CALLBACK_MALFORMED",
        "callback XML contains CDATA (unsupported)",
      );
    }
    const openMatch = /^<([A-Za-z][A-Za-z0-9_.-]*)\s*(\/?)>/.exec(
      inner.slice(cursor),
    );
    if (!openMatch) {
      const rest = inner.slice(cursor, cursor + 24);
      throw new WechatError(
        "WECHAT_CALLBACK_MALFORMED",
        "callback XML child element is malformed",
        { rest },
      );
    }
    const tag = openMatch[1];
    if (openMatch[2] === "/") {
      // Self-closing child = empty value.
      fields[tag] = "";
      cursor += openMatch[0].length;
      continue;
    }
    const closeIndex = inner.indexOf(`</${tag}>`, cursor + openMatch[0].length);
    if (closeIndex < 0) {
      throw new WechatError(
        "WECHAT_CALLBACK_MALFORMED",
        "callback XML child element is not closed",
        { tag },
      );
    }
    const value = inner.slice(cursor + openMatch[0].length, closeIndex);
    if (/<[A-Za-z!?/]/.test(value)) {
      throw new WechatError(
        "WECHAT_CALLBACK_MALFORMED",
        "callback XML child element contains nested markup",
        { tag },
      );
    }
    fields[tag] = decodeEntities(value);
    cursor = closeIndex + tag.length + 3;
  }

  return { root, fields };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Serialize flat fields back into WeChat reply XML (for passive replies). */
export function buildWechatXml(root: string, fields: XmlObject): string {
  const body = Object.entries(fields)
    .map(
      ([tag, value]) =>
        `<${tag}>${String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</${tag}>`,
    )
    .join("");
  return `<${root}>${body}</${root}>`;
}
