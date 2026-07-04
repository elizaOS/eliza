/**
 * Wraps @json-render/core's pipe with the Eliza GenUI patch application, so a
 * streamed spec renders incrementally through the shared pipe.
 */
import { pipeJsonRender as officialPipeJsonRender } from "@json-render/core";
import { applyElizaGenUiPatch } from "./streaming";
import type {
  ElizaGenUiPatch,
  ElizaGenUiSpec,
  ElizaGenUiSpecStreamPart,
  ElizaGenUiValidationOptions,
} from "./types";

// ── Re-exports ───────────────────────────────────────────────────────

export { officialPipeJsonRender as pipeJsonRender1 };

// ── Custom pipe functions (ElizaGenUiSpec-compatible) ────────────────

const PATCH_OP_RE = /^\s*\{/;

function tryParsePatchLine(line: string): ElizaGenUiPatch | null {
  const trimmed = line.trim();
  if (!PATCH_OP_RE.test(trimmed)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.op === "string" &&
      typeof parsed.path === "string"
    ) {
      return parsed as ElizaGenUiPatch;
    }
  } catch {
    // not JSON
  }
  return null;
}

export function pipeJsonRenderLines(input: string): ElizaGenUiSpecStreamPart[] {
  const parts: ElizaGenUiSpecStreamPart[] = [];
  const textLines: string[] = [];

  for (const line of input.split("\n")) {
    const patch = tryParsePatchLine(line);
    if (patch) {
      if (textLines.length > 0) {
        parts.push({ type: "text", text: textLines.join("\n") });
        textLines.length = 0;
      }
      parts.push({ type: "spec-patch", patch });
    } else {
      textLines.push(line);
    }
  }

  if (textLines.length > 0) {
    parts.push({ type: "text", text: textLines.join("\n") });
  }

  return parts;
}

export function pipeJsonRenderStream(
  chunks: AsyncIterable<string> | ReadableStream<string>,
  initialSpec?: ElizaGenUiSpec,
  validationOptions?: ElizaGenUiValidationOptions,
): ReadableStream<ElizaGenUiSpecStreamPart> {
  let currentSpec: ElizaGenUiSpec | undefined = initialSpec
    ? (structuredClone(initialSpec) as ElizaGenUiSpec)
    : undefined;

  let buffer = "";

  return new ReadableStream<ElizaGenUiSpecStreamPart>({
    async start(controller) {
      const iterator =
        Symbol.asyncIterator in chunks
          ? (chunks as AsyncIterable<string>)[Symbol.asyncIterator]()
          : (chunks as ReadableStream<string>).getReader();

      try {
        while (true) {
          let chunk: string;
          let done: boolean;

          if ("read" in iterator) {
            const result = await iterator.read();
            chunk = typeof result.value === "string" ? result.value : "";
            done = result.done ?? false;
          } else {
            const result = await iterator.next();
            chunk = typeof result.value === "string" ? result.value : "";
            done = result.done ?? false;
          }

          if (done) break;

          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const patch = tryParsePatchLine(line);
            if (patch) {
              if (currentSpec) {
                const result = applyElizaGenUiPatch(
                  currentSpec,
                  [patch],
                  validationOptions,
                );
                if (result.ok && result.spec) {
                  currentSpec = result.spec;
                }
              }
              controller.enqueue({ type: "spec-patch", patch });
            } else {
              controller.enqueue({ type: "text", text: `${line}\n` });
            }
          }
        }

        if (currentSpec) {
          controller.enqueue({
            type: "spec-complete",
            spec: currentSpec,
          });
        }
      } finally {
        controller.close();
        if ("releaseLock" in iterator) {
          iterator.releaseLock();
        }
      }
    },
  });
}

export function compilePatchesToSpec(
  patches: readonly ElizaGenUiPatch[],
  validationOptions?: ElizaGenUiValidationOptions,
): { spec: ElizaGenUiSpec | null; errors: readonly string[] } {
  const initial: ElizaGenUiSpec = {
    version: "0.1",
    root: "",
    components: [],
  };
  const result = applyElizaGenUiPatch(initial, patches, validationOptions);
  if (result.ok) {
    return { spec: result.spec, errors: [] };
  }
  return {
    spec: null,
    errors: result.errors.map((e: { message: string }) => e.message),
  };
}
