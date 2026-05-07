#!/usr/bin/env bun
/**
 * Legacy-only streaming TOON encoder for compatibility corpus tooling.
 *
 * Native v5 tool-calling exports must be JSON and must not call this tool.
 *
 * Reads NDJSON from stdin (one JSON value per line) and writes one JSON-
 * encoded TOON string per line to stdout. Using JSON-encoding for the
 * output guarantees there's no newline ambiguity even though TOON itself
 * is multi-line.
 *
 * On error the line `{"error":"..."}` is written and processing continues.
 *
 * --- ROUND-TRIP SAFETY POSTPROCESS ---
 * The upstream `@toon-format/toon` (v2.1.0) decoder has a bug: when a
 * key:value line in object context has an unquoted key and the quoted
 * string value contains `[<digits>]:` followed by a delimiter, the
 * decoder mistakenly interprets the contents of the quoted string as an
 * inline array header. Reproducer:
 *
 *     decode('foo: "[0]: a,b,c,d"')
 *     // → RangeError: Expected 0 inline array items, but got 4
 *
 * In some cases the decoder *silently corrupts* the result. The trigger
 * is `parseArrayHeaderLine` calling `content.indexOf("[")` instead of
 * `findUnquotedChar(content, "[")`, so an open-bracket inside a quoted
 * string is mis-tokenized as an array header.
 *
 * Workaround: walk the encoded output and replace `key: "..."` with
 * `"key": "..."` whenever the value contains `[`. The decoder's quoted-
 * key branch uses `findClosingQuote`, which IS escape-aware, so this
 * forces the parser onto the correct path. The change is purely
 * cosmetic at the TOON layer (quoted vs unquoted key for an
 * identifier-shaped name); the decoded JSON is identical.
 */

import { encode } from "@toon-format/toon";
import { createInterface } from "node:readline";

// matches: [indent](- )?<unquoted_key>: "<value>"
// where <unquoted_key> is identifier-shaped (encoder leaves these unquoted)
// and <value> is a fully-quoted string (encoder always quotes when value has structural chars).
const RISKY_LINE_RE = /^([ \t]*)(- )?([A-Za-z_][A-Za-z0-9_.\-]*): (".*")$/;

// Matches a line whose KEY is a TOON-quoted string ending in `:` (followed by
// the structural colon-space-value). The upstream decoder's
// decodeKeyValueSync uses `content.indexOf(COLON, key.length)` to locate the
// structural colon, which mis-fires when the quoted key has a trailing `:` —
// the search lands on the colon INSIDE the quoted region instead of the
// structural one after the closing quote, and the rest of the line is
// reinterpreted as an unterminated string (see node_modules/@toon-format/
// toon/dist/index.mjs L515-526).
//
// Workaround: rewrite the trailing `:` inside the key as `ː` (the
// Modifier Letter Triangular Colon — visually ≈ `ː`, never confused with
// structural `:` by the parser). This is a *lossy* cosmetic edit on the key,
// applied only to keys that would otherwise crash the decoder. The decoded
// JSON's key string changes from "X:" to "Xː" — acceptable for the n8n
// `params.body.<question>:` field where the key is a free-form question label.
const QUOTED_KEY_TRAILING_COLON_RE = /^([ \t]*)(- )?"((?:[^"\\]|\\.)*?):":\s/;

function patchEncoded(encoded) {
  const hasBracket = encoded.includes("[");
  const hasQuotedColonKey = encoded.includes(':":');
  if (!hasBracket && !hasQuotedColonKey) return encoded;
  const lines = encoded.split("\n");
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pass 1 — value contains `[`, key is identifier-shaped + unquoted:
    // re-quote the key (the decoder's quoted-key branch is escape-aware).
    const m = line.match(RISKY_LINE_RE);
    if (m) {
      const [, indent, dash, key, value] = m;
      if (value.includes("[")) {
        lines[i] = `${indent}${dash || ""}"${key}": ${value}`;
        mutated = true;
        continue;
      }
    }

    // Pass 2 — quoted key ends with `:`. Replace the trailing `:` with `ː`
    // (U+02D0) so the decoder's indexOf-based colon hunt cannot lock onto it.
    const q = line.match(QUOTED_KEY_TRAILING_COLON_RE);
    if (q) {
      const [, indent, dash, keyBody] = q;
      const rest = line.slice(q[0].length);
      lines[i] = `${indent}${dash || ""}"${keyBody}ː": ${rest}`;
      mutated = true;
    }
  }
  return mutated ? lines.join("\n") : encoded;
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const value = JSON.parse(line);
    const toon = patchEncoded(encode(value));
    process.stdout.write(JSON.stringify({ toon }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e) }) + "\n");
  }
});

rl.on("close", () => process.exit(0));
