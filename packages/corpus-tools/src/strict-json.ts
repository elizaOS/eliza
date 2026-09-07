/** Parses JSON without permitting duplicate object keys to collapse through last-wins semantics. */

import { parseDocument } from "yaml";

/** Parse one strict JSON value while rejecting decoded duplicate object keys. */
export function parseStrictJson(source: string, label: string): unknown {
  try {
    const value: unknown = JSON.parse(source);
    const document = parseDocument(source, {
      merge: false,
      prettyErrors: true,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new Error(
        document.errors.map((diagnostic) => diagnostic.message).join("; "),
      );
    }
    return value;
  } catch (error) {
    throw new TypeError(`${label} is not valid strict JSON`, { cause: error });
  }
}
