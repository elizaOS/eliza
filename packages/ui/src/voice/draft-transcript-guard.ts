export type DraftTranscriptResult =
  | { kind: "applied"; value: string }
  | { kind: "conflict"; value: string }
  | { kind: "ignored" };
/** Distinguishes this capture's preview updates from subsequent user edits. */
export class DraftTranscriptGuard {
  private current = "";
  private revision = 0;
  private generation = 0;
  get value(): string {
    return this.current;
  }
  observe(value: string): void {
    if (value !== this.current) {
      this.current = value;
      this.revision++;
    }
  }
  invalidate(): void {
    this.generation++;
  }
  begin(
    compose: (original: string, transcript: string) => string,
  ): (text: string, final: boolean) => DraftTranscriptResult {
    const revision = this.revision,
      original = this.current,
      ticket = ++this.generation;
    return (text, final) => {
      if (ticket !== this.generation) return { kind: "ignored" };
      if (revision !== this.revision)
        return final ? { kind: "conflict", value: text } : { kind: "ignored" };
      const value = compose(original, text);
      this.current = value;
      return { kind: "applied", value };
    };
  }
}
