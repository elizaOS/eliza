/**
 * Browser shim for the `cron-parser` package, mirroring the
 * `CronExpressionParser.parse(expr).next().toDate()` surface the app consumes.
 * `parse` validates a 5-field expression against the same per-field grammar the
 * server scheduler (`parseCronExpression` in
 * `packages/core/src/services/triggerScheduling.ts`) accepts — `*`, star-steps
 * (`*` every N), comma lists (`0,30`), ranges (`9-17`), range-steps (`0-11`
 * every 2), and value-steps (`0/15`, `5/15`: from N to the field max every
 * step) — while still rejecting malformed or out-of-range fields. Named tokens
 * (`MON`, `JAN`) are deliberately rejected because the server scheduler rejects
 * them too; accepting them here would let the form save a trigger the backend
 * never runs. The returned iterator is minimal: each
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
// range-step `A-B/N`, a value-step `N/S`, or a bare integer, matching the
// server scheduler's field grammar (`parseCronPart` in triggerScheduling.ts).
function validateFieldElement(
  element: string,
  min: number,
  max: number,
  field: string,
): void {
  if (element === "*") return;

  // A trailing `/step` may qualify any base term (`*/S`, `N/S`, `A-B/S`). Like
  // the server scheduler, only a non-integer or non-positive step is rejected;
  // a step that overshoots the range simply fires once at the base value.
  const slashParts = element.split("/");
  if (slashParts.length > 2) {
    throw new Error(`Invalid cron field: ${field}`);
  }
  if (slashParts.length === 2) {
    const stepToken = slashParts[1];
    if (!/^\d+$/.test(stepToken) || Number(stepToken) <= 0) {
      throw new Error(`Invalid cron field: ${field}`);
    }
  }

  const base = slashParts[0];
  if (base === "*") return;

  const range = base.match(/^(\d+)-(\d+)$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron field: ${field}`);
    }
    return;
  }

  if (/^\d+$/.test(base)) {
    const parsed = Number(base);
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
