/** Shared test doubles: a fake DocumentSink and a fake streaming parser. */

import type {
  DocumentSink,
  SinkAddResult,
  SinkDocument,
} from "../core/sink.ts";
import type { NormalizedConversation } from "../core/types.ts";

/** Records every stored document; simulates content-based dedup by filename+content. */
export class FakeDocumentSink implements DocumentSink {
  readonly stored = new Map<string, SinkDocument>();
  readonly deleted: string[] = [];
  /** All addDocument calls, in order (including deduped skips). */
  readonly addCalls: SinkDocument[] = [];
  private seq = 0;
  /** When true, a repeat (same filename+content) returns status: "skipped". */
  dedup: boolean;

  constructor(opts: { dedup?: boolean } = {}) {
    this.dedup = opts.dedup ?? true;
  }

  private key(doc: SinkDocument): string {
    return `${doc.originalFilename}::${doc.content}`;
  }

  async addDocument(doc: SinkDocument): Promise<SinkAddResult> {
    this.addCalls.push(doc);
    const dedupKey = this.key(doc);
    if (this.dedup) {
      for (const [id, existing] of this.stored) {
        if (this.key(existing) === dedupKey) {
          return { id, status: "skipped" };
        }
      }
    }
    const id = `doc-${++this.seq}`;
    this.stored.set(id, doc);
    return { id, status: "stored" };
  }

  async deleteDocument(id: string): Promise<void> {
    this.deleted.push(id);
    this.stored.delete(id);
  }
}

/** Turn an array of conversations into an AsyncIterable (a fake parser stream). */
export async function* streamConversations(
  conversations: NormalizedConversation[],
  onYield?: (c: NormalizedConversation) => void,
): AsyncIterable<NormalizedConversation> {
  for (const c of conversations) {
    onYield?.(c);
    // Yield to the microtask queue so laziness is observable in tests.
    await Promise.resolve();
    yield c;
  }
}

/** Build a minimal conversation fixture. */
export function conv(
  partial: Partial<NormalizedConversation> & { sourceConversationId: string },
): NormalizedConversation {
  return {
    title: "Untitled",
    createdAt: Date.parse("2024-05-01T12:00:00Z"),
    updatedAt: Date.parse("2024-05-01T12:05:00Z"),
    messages: [
      {
        role: "user",
        text: "hello",
        createdAt: Date.parse("2024-05-01T12:00:00Z"),
      },
      {
        role: "assistant",
        text: "hi there",
        createdAt: Date.parse("2024-05-01T12:01:00Z"),
      },
    ],
    ...partial,
  };
}
