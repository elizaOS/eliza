/**
 * Data schema for walkthrough definitions: a walkthrough is a list of steps, not
 * a hand-written Playwright spec, so one driver runs N walkthroughs and the set
 * is auditable as JSON. Definitions live as `walkthroughs/*.json` (or `.ts`
 * exporting a `WalkthroughDef`) and are validated here at load time — an unknown
 * `action`, a `click` with no `selector`, or a `fill` with no `value` is a typed
 * `EvidenceValidationError`, never a step that silently does nothing at runtime.
 *
 * The action vocabulary is deliberately small and declarative (`goto`, `click`,
 * `fill`, `hover`, `waitFor`, `scroll`, `assertText`); anything a walkthrough
 * needs beyond it is a signal to add a first-class action here, not to smuggle
 * imperative code into a definition. `zod` validates; the inferred type is the
 * contract the driver consumes, so schema and type cannot drift.
 */

import { z } from "zod";
import { EvidenceValidationError } from "../errors.ts";
import { VIDEO_GRANULARITIES } from "./ingest.ts";

/** Step action verbs the driver knows how to execute. */
export const WALKTHROUGH_ACTIONS = [
  "goto",
  "click",
  "fill",
  "hover",
  "waitFor",
  "scroll",
  "assertText",
] as const;
export type WalkthroughAction = (typeof WALKTHROUGH_ACTIONS)[number];

const stepBase = {
  /** Short human label for the step, surfaced in the steps-log and screenshots. */
  label: z.string().min(1).optional(),
  /** Capture a screenshot after this step, tagged with the step index/label. */
  screenshotAfter: z.boolean().optional(),
  /** Capture an ARIA-snapshot (html-tree) after this step for structural diff. */
  ariaAfter: z.boolean().optional(),
};

// A goto target is either a relative path (no scheme; resolved against the
// run's baseUrl — the fixture server's or the booted app's http origin) or an
// absolute http(s) URL. Any other explicit scheme (file:, javascript:, data:,
// …) is rejected at validation time: page.goto on such a URL would screenshot
// local files or execute script straight into an evidence bundle.
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
function isHttpOrRelative(value: string): boolean {
  const scheme = SCHEME_PREFIX.exec(value);
  if (scheme === null) return true;
  return /^https?:$/i.test(scheme[0]);
}
const NON_HTTP_MESSAGE =
  "must be an http(s) URL or a relative path (non-http(s) schemes are not allowed)";

// Each action carries exactly the fields it needs; a discriminated union means
// `click` without a `selector` fails validation instead of no-op'ing at runtime.
const stepSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("goto"),
    /** http(s) URL, or a path resolved against the run's baseUrl. */
    value: z
      .string()
      .min(1)
      .refine(isHttpOrRelative, {
        message: `goto value ${NON_HTTP_MESSAGE}`,
      }),
    ...stepBase,
  }),
  z.strictObject({
    action: z.literal("click"),
    selector: z.string().min(1),
    ...stepBase,
  }),
  z.strictObject({
    action: z.literal("fill"),
    selector: z.string().min(1),
    value: z.string(),
    ...stepBase,
  }),
  z.strictObject({
    action: z.literal("hover"),
    selector: z.string().min(1),
    ...stepBase,
  }),
  z.strictObject({
    action: z.literal("waitFor"),
    /** CSS selector to wait for, when waiting on an element. */
    selector: z.string().min(1).optional(),
    /** Milliseconds to wait, when waiting on time. One of selector/value required. */
    value: z.string().min(1).optional(),
    ...stepBase,
  }),
  z.strictObject({
    action: z.literal("scroll"),
    /** Element to scroll into view; omit to scroll the page by `value` px. */
    selector: z.string().min(1).optional(),
    /** Pixels to scroll the window when no selector is given. */
    value: z.string().min(1).optional(),
    ...stepBase,
  }),
  z.strictObject({
    action: z.literal("assertText"),
    /** Scope the text search to this selector; omit to search the whole page. */
    selector: z.string().min(1).optional(),
    /** Text that must be present. */
    value: z.string().min(1),
    ...stepBase,
  }),
]);

const walkthroughSchema = z
  .strictObject({
    /** Filesystem-safe id; becomes the ingested video's slug. */
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: "slug must be lowercase alphanumeric with dashes",
    }),
    /** Which evidence lane the produced video belongs to. */
    granularity: z.enum(VIDEO_GRANULARITIES),
    /** Human title for the walkthrough. */
    title: z.string().min(1).optional(),
    /** Default base URL for relative `goto` steps; overridable at run time. */
    baseUrl: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value), {
        message: "baseUrl must be an http(s) URL",
      })
      .optional(),
    /**
     * Marks a walkthrough that can only run against the booted real app (no
     * self-contained fixture). The driver refuses to run it without an explicit
     * baseUrl so it can never fabricate a fixture pass for a real-app flow.
     */
    requiresApp: z.boolean().optional(),
    steps: z.array(stepSchema).min(1),
  })
  .superRefine((def, ctx) => {
    def.steps.forEach((step, index) => {
      if (
        step.action === "waitFor" &&
        step.selector === undefined &&
        step.value === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index],
          message: "waitFor requires a selector or a value (ms)",
        });
      }
      // The driver executes selector-or-value, never both; accepting both
      // would silently ignore one field of the definition.
      if (
        step.action === "waitFor" &&
        step.selector !== undefined &&
        step.value !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index],
          message:
            "waitFor takes a selector or a value (ms), not both (the value would be ignored)",
        });
      }
      if (
        step.action === "waitFor" &&
        step.value !== undefined &&
        !isNonNegativeNumber(step.value)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "value"],
          message: "waitFor value must be a non-negative millisecond count",
        });
      }
      if (
        step.action === "scroll" &&
        step.selector === undefined &&
        step.value === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index],
          message: "scroll requires a selector or a value (px)",
        });
      }
      if (
        step.action === "scroll" &&
        step.selector !== undefined &&
        step.value !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index],
          message:
            "scroll takes a selector or a value (px), not both (the value would be ignored)",
        });
      }
      if (
        step.action === "scroll" &&
        step.selector === undefined &&
        step.value !== undefined &&
        !isFiniteNumber(step.value)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "value"],
          message: "scroll value must be a finite pixel count",
        });
      }
    });
  });

/** A validated walkthrough definition — the contract the driver consumes. */
export type WalkthroughDef = z.infer<typeof walkthroughSchema>;
/** One validated step. */
export type WalkthroughStep = WalkthroughDef["steps"][number];

/**
 * Validate an untrusted value (parsed JSON / imported module) as a walkthrough
 * definition. Throws `EvidenceValidationError` with every field issue on
 * failure — an unknown action, a missing selector, or an empty step list is a
 * typed rejection, never a silently-repaired definition.
 */
export function parseWalkthroughDef(
  value: unknown,
  described: string,
): WalkthroughDef {
  const result = walkthroughSchema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "$",
    message: issue.message,
  }));
  throw new EvidenceValidationError(
    `invalid walkthrough definition (${described}): ${issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ")}`,
    issues,
    { code: "WALKTHROUGH_DEF_INVALID" },
  );
}

function isFiniteNumber(value: string): boolean {
  return Number.isFinite(Number(value));
}

function isNonNegativeNumber(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}
