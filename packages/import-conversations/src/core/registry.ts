/**
 * Conversation-importer registry — eliza's missing
 * `registerMigrationProvider`-equivalent, scoped to conversation import.
 *
 * A parser declares the `source` it handles, a `detect(input)` predicate, and a
 * `parse(input)` streaming function that yields NormalizedConversations. Tracks
 * B/C/D register their parsers here; the pipeline / app side resolves a parser
 * for a given upload by `detect` or by explicit source.
 */

import type { ConversationSource, NormalizedConversation } from "./types.ts";

/**
 * A source parser. `parse` is streaming by construction — it returns an
 * AsyncIterable so the pipeline never buffers an entire export in memory.
 *
 * @typeParam TInput - the parser's input shape (e.g. a zip handle, a directory
 * path, a readable stream). Kept generic so core does not constrain source
 * acquisition; the registry stores parsers as `ConversationImporter<unknown>`.
 */
export interface ConversationImporter<TInput = unknown> {
  source: ConversationSource;
  /** Cheap probe: does this parser recognize the given input? */
  detect(input: TInput): boolean | Promise<boolean>;
  /** Stream normalized conversations from the input. */
  parse(input: TInput): AsyncIterable<NormalizedConversation>;
}

/**
 * A registry of conversation importers. A default shared instance is exported;
 * callers may also construct isolated registries (tests, multi-tenant).
 */
export class ConversationImporterRegistry {
  private readonly bySource = new Map<string, ConversationImporter>();

  /** Register (or replace) a parser for its `source`. Returns an unregister fn. */
  register<TInput>(parser: ConversationImporter<TInput>): () => void {
    if (!parser.source) {
      throw new Error("ConversationImporter.source must be a non-empty string");
    }
    this.bySource.set(parser.source, parser as ConversationImporter);
    return () => {
      // Only remove if the same parser instance is still registered.
      if (
        this.bySource.get(parser.source) === (parser as ConversationImporter)
      ) {
        this.bySource.delete(parser.source);
      }
    };
  }

  /** Look up a parser by its source id. */
  get(source: ConversationSource): ConversationImporter | undefined {
    return this.bySource.get(source);
  }

  /** True when a parser is registered for `source`. */
  has(source: ConversationSource): boolean {
    return this.bySource.has(source);
  }

  /** All registered source ids. */
  sources(): ConversationSource[] {
    return [...this.bySource.keys()];
  }

  /** All registered parsers. */
  all(): ConversationImporter[] {
    return [...this.bySource.values()];
  }

  /**
   * Resolve the first parser whose `detect(input)` returns true. Parsers are
   * probed in registration order. Returns `undefined` when none match.
   */
  async detect(input: unknown): Promise<ConversationImporter | undefined> {
    for (const parser of this.bySource.values()) {
      if (await parser.detect(input)) {
        return parser;
      }
    }
    return undefined;
  }

  /** Remove all registered parsers (primarily for tests). */
  clear(): void {
    this.bySource.clear();
  }
}

/** The default, process-wide importer registry. */
export const conversationImporterRegistry = new ConversationImporterRegistry();

/**
 * Register a conversation importer on the default registry. Mirrors the
 * ergonomics of openclaw's `api.registerMigrationProvider(...)`.
 */
export function registerConversationImporter<TInput>(
  parser: ConversationImporter<TInput>,
): () => void {
  return conversationImporterRegistry.register(parser);
}
