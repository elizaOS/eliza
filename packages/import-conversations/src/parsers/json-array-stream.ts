import type { Readable } from "node:stream";

/**
 * Stream a top-level JSON array one object at a time.
 *
 * Conversation exports put all conversations in a single `conversations.json`
 * array. This parser keeps memory bounded by accumulating only the current
 * top-level object before handing it to `JSON.parse`.
 */
export async function* streamJsonArrayObjects(
  source: Readable,
): AsyncIterable<unknown> {
  source.setEncoding("utf8");

  let sawArrayStart = false;
  let sawArrayEnd = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = "";

  try {
    for await (const chunk of source as AsyncIterable<string>) {
      for (const ch of chunk) {
        if (!sawArrayStart) {
          if (/\s/.test(ch)) continue;
          if (ch !== "[") {
            throw new Error("Expected conversations.json to be a JSON array");
          }
          sawArrayStart = true;
          continue;
        }

        if (sawArrayEnd) {
          if (/\s/.test(ch)) continue;
          throw new Error("Unexpected trailing data after JSON array");
        }

        if (depth === 0) {
          if (/\s/.test(ch) || ch === ",") continue;
          if (ch === "]") {
            sawArrayEnd = true;
            continue;
          }
          if (ch !== "{") {
            throw new Error("Expected a conversation object in JSON array");
          }
          depth = 1;
          current = "{";
          inString = false;
          escaped = false;
          continue;
        }

        current += ch;

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === "\\") {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }

        if (ch === "{" || ch === "[") {
          depth += 1;
          continue;
        }

        if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            yield JSON.parse(current) as unknown;
            current = "";
          }
        }
      }
    }

    if (!sawArrayStart) {
      throw new Error("Expected conversations.json to be a JSON array");
    }
    if (depth !== 0 || inString) {
      throw new Error("Unexpected end of JSON while reading conversation");
    }
    if (!sawArrayEnd) {
      throw new Error("Unexpected end of JSON array");
    }
  } finally {
    source.destroy();
  }
}

/** Read the first object from a streamed JSON array, then close the stream. */
export async function readFirstJsonArrayObject(
  source: Readable,
): Promise<unknown | undefined> {
  const iterator = streamJsonArrayObjects(source)[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    return first.done ? undefined : first.value;
  } finally {
    await iterator.return?.();
  }
}
