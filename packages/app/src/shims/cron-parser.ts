type ParseOptions = {
  currentDate?: Date | string | number;
};

function parseField(value: string, min: number, max: number): number {
  if (value === "*") return min;
  const interval = value.match(/^\*\/(\d+)$/);
  if (interval) {
    const parsed = Number(interval[1]);
    if (Number.isInteger(parsed) && parsed > 0) return min;
  }
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
    return parsed;
  }
  throw new Error(`Invalid cron field: ${value}`);
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
