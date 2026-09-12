/**
 * Hardened XML support for first-party WeChat platform callbacks. WeChat's MP
 * and WeCom message XML is strictly flat (a root element whose children are
 * all leaf text nodes), so this module implements exactly that subset with a
 * hand-rolled parser that rejects DTDs, entity declarations, comments,
 * processing instructions, nesting, duplicate roots, and oversized inputs.
 * Leaf values wrapped in CDATA sections — the form the platforms'
 * reference implementations actually emit — are captured verbatim; a CDATA
 * section cannot contain its own terminator, so nesting is structurally
 * impossible. Parsing happens only after signature verification.
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

  // The root's close tag must be located outside CDATA sections: a literal
  // `</xml>` inside CDATA content is data, not markup. Scan candidates left to
  // right, skipping any occurrence nested inside a CDATA terminator.
  let closingIndex = -1;
  {
    let scan = 0;
    for (;;) {
      const idx = withoutDecl.indexOf(`</${root}>`, scan);
      if (idx < 0) break;
      // count CDATA openers/closers before idx to see if idx sits inside one
      let inCdata = false;
      let pos = withoutDecl.indexOf("<![CDATA[");
      while (pos >= 0 && pos < idx) {
        const end = withoutDecl.indexOf("]]>", pos);
        if (end < 0) break;
        if (end + 3 > idx) {
          inCdata = true;
          break;
        }
        pos = withoutDecl.indexOf("<![CDATA[", end + 3);
      }
      if (!inCdata) {
        closingIndex = idx;
        break;
      }
      scan = idx + 1;
    }
  }
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
    // Platform envelopes place newline whitespace between children; skip it
    // before looking for the next open tag (element content itself never
    // leans on this — child values are matched between their own tags).
    while (cursor < inner.length && /\s/.test(inner[cursor])) {
      cursor += 1;
    }
    if (cursor >= inner.length) break;
    const openMatch = /^<([A-Za-z][A-Za-z0-9_.-]*)\s*(\/?)>/.exec(
      inner.slice(cursor),
    );
    if (!openMatch) {
      const rest = inner.slice(cursor, cursor + 24);
      throw new WechatError(
        "WECHAT_CALLBACK_MALFORMED",
        "callback XML child element is malformed",
        {
          rest,
        },
      );
    }
    const tag = openMatch[1];
    if (openMatch[2] === "/") {
      // Self-closing child = empty value.
      fields[tag] = "";
      cursor += openMatch[0].length;
      continue;
    }
    // Platform payloads conventionally wrap leaf values in CDATA. A CDATA
    // section's content is character data: capture it verbatim (it cannot
    // contain the terminator "]]>" so nesting is structurally impossible),
    // then require the closing tag to match the opener.
    if (inner.startsWith("<![CDATA[", cursor + openMatch[0].length)) {
      const cdataStart = cursor + openMatch[0].length + "<![CDATA[".length;
      const cdataEnd = inner.indexOf("]]>", cdataStart);
      if (cdataEnd < 0) {
        throw new WechatError(
          "WECHAT_CALLBACK_MALFORMED",
          "callback XML CDATA section is not terminated",
          { tag },
        );
      }
      const afterCdata = cdataEnd + "]]>".length;
      const closeTag = `</${tag}>`;
      if (!inner.startsWith(closeTag, afterCdata)) {
        throw new WechatError(
          "WECHAT_CALLBACK_MALFORMED",
          "callback XML CDATA child is not closed by its opening tag",
          { tag },
        );
      }
      // CDATA content is character data, verbatim: entity references inside
      // CDATA are literal text, not markup, and are NOT decoded.
      fields[tag] = inner.slice(cdataStart, cdataEnd);
      cursor = afterCdata + closeTag.length;
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
