/**
 * Setup hook that fails the suite if any test is skipped without an explicit
 * `SKIP_REASON` environment variable.
 *
 * Rationale: credential-gated live/real suites historically passed CI silently
 * when the relevant secret was missing. This made silent regressions invisible.
 * Skipping must now be a deliberate, documented act:
 *
 *   SKIP_REASON="awaiting Twilio sandbox" bun run test:ci:real
 *
 * The reason is recorded in the run logs; absence of a reason fails the run.
 *
 * Opt-out: set `ELIZA_ALLOW_SILENT_SKIP=1` (only intended for local
 * exploration; CI must never set this).
 */

import { afterAll, beforeEach } from "vitest";

type SkippableTask = {
  mode?: string;
  name?: string;
  file?: { name?: string };
  suite?: { name?: string };
};

const skipped: Array<{ name: string; file: string }> = [];

beforeEach((ctx) => {
  const task = ctx.task as SkippableTask;
  if (task.mode === "skip" || task.mode === "todo") {
    skipped.push({
      name: task.name ?? "<unknown>",
      file: task.file?.name ?? "<unknown>",
    });
  }
});

afterAll(() => {
  if (skipped.length === 0) return;
  if (process.env.ELIZA_ALLOW_SILENT_SKIP === "1") return;
  const reason = process.env.SKIP_REASON?.trim();
  if (reason && reason.length > 0) {
    console.warn(
      `[fail-on-silent-skip] ${skipped.length} skip(s) accepted with SKIP_REASON="${reason}"`,
    );
    return;
  }
  const sample = skipped
    .slice(0, 10)
    .map((entry) => `  - ${entry.file} :: ${entry.name}`)
    .join("\n");
  const more =
    skipped.length > 10 ? `\n  ... +${skipped.length - 10} more` : "";
  throw new Error(
    `[fail-on-silent-skip] ${skipped.length} test(s) skipped without SKIP_REASON.\n` +
      `Set SKIP_REASON="<why>" to acknowledge. Skipped:\n${sample}${more}`,
  );
});
