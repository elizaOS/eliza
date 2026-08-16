/**
 * Browser shim for the `cron-parser` package, mirroring the
 * `CronExpressionParser.parse(expr).next().toDate()` surface the app consumes.
 * `parse` validates a 5-field expression against the same per-field grammar the
 * real cron-parser accepts — `*`, step values (every-N), comma lists (`0,30`),
 * ranges (`9-17`), and range-steps (`0-11` every 2) — while still rejecting
 * malformed or out-of-range fields. The returned iterator is minimal: each
 * `next()` advances the cursor by one minute from `currentDate` rather than
 * resolving the true next matching instant — enough to satisfy validation and
 * the API shape in the bundle without the full scheduler engine.
 *
 * This is the parser the shipped Triggers form validates against: it is aliased
 * over the npm `cron-parser` for the whole app bundle in `vite.config.ts`, and
 * `packages/ui/.../trigger-form-utils.ts` calls its `parse` through
 * `validateCronExpression`/`nextRunsForCron`. Rejecting valid list/range/step
 * syntax here blocks users from creating recurring triggers the backend accepts.
 */
type ParseOptions = {
  currentDate?: Date | string | number;
};

// Validate one comma-list element of a cron field: `*`, `*/N`, a range `A-B`, a
// range-step `A-B/N`, or a bare integer, matching cron-parser's field grammar.
function validateFieldElement(
  element: string,
  min: number,
  max: number,
  field: string,
): void {
  if (element === "*") return;

  const step = element.match(/^\*\/(\d+)$/);
  if (step) {
    // A star-step fires from `min` every N; cron-parser only rejects a zero
    // step, even when N exceeds the range (a step of 60 fires once at `min`).
    if (Number(step[1]) > 0) return;
    throw new Error(`Invalid cron field: ${field}`);
  }

  const range = element.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    const rangeStep = range[3] === undefined ? 1 : Number(range[3]);
    if (lo < min || hi > max || lo > hi || rangeStep <= 0) {
      throw new Error(`Invalid cron field: ${field}`);
    }
    return;
  }

  if (/^\d+$/.test(element)) {
    const parsed = Number(element);
    if (parsed >= min && parsed <= max) return;
  }

  throw new Error(`Invalid cron field: ${field}`);
}

function parseField(value: string, min: number, max: number): void {
  const elements = value.split(",");
  for (const element of elements) {
    validateFieldElement(element, min, max, value);
  }
}

class ParsedCronExpression {
  private cursor: Date;

  constructor(expr: string, options: ParseOptions = {}) {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error("Cron expression must have 5 fields");
    }
    parseField(fields[0], 0, 59);
    parseField(fields[1], 0, 23);
    parseField(fields[2], 1, 31);
    parseField(fields[3], 1, 12);
    parseField(fields[4], 0, 7);
    this.cursor = new Date(options.currentDate ?? Date.now());
  }

  next(): { toDate: () => Date } {
    this.cursor = new Date(this.cursor.getTime() + 60_000);
    const value = new Date(this.cursor);
    return { toDate: () => value };
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: Mirrors cron-parser's public API.
export class CronExpressionParser {
  static parse(expr: string, options?: ParseOptions): ParsedCronExpression {
    return new ParsedCronExpression(expr, options);
  }
}

export default CronExpressionParser;
