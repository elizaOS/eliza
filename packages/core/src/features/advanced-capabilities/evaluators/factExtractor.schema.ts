/**
 * Zod schemas for the unified fact extractor.
 *
 * One LLM call per message produces a list of operations that mutate the
 * fact store: insert a new durable/current fact, strengthen or decay an
 * existing one, or queue a contradiction for review. The schema is
 * discriminated on the `op` field so a single `safeParse` validates every
 * variant in one pass.
 *
 * See `docs/architecture/fact-memory.md` for the full pipeline.
 */

import z from "zod";

/**
 * Categories that durable facts can belong to. Closed set — the extractor
 * must pick exactly one. Mirrors {@link DurableFactCategory} in
 * `types/memory.ts`.
 */
export const DurableCategoryEnum = z.enum([
	"identity",
	"health",
	"relationship",
	"life_event",
	"business_role",
	"preference",
	"goal",
]);

export type DurableCategory = z.infer<typeof DurableCategoryEnum>;

/**
 * Categories that current (time-bound) facts can belong to. Closed set.
 * Mirrors {@link CurrentFactCategory} in `types/memory.ts`.
 */
export const CurrentCategoryEnum = z.enum([
	"feeling",
	"physical_state",
	"working_on",
	"going_through",
	"schedule_context",
]);

export type CurrentCategory = z.infer<typeof CurrentCategoryEnum>;

/**
 * Verification provenance for a newly extracted fact. Defaults to
 * `self_reported`; the model only emits `confirmed` when the message itself
 * cites external corroboration (a lab result, a calendar entry, etc.).
 */
export const VerificationStatusEnum = z.enum([
	"self_reported",
	"confirmed",
	"contradicted",
]);

export type VerificationStatus = z.infer<typeof VerificationStatusEnum>;

/**
 * Structured fields the model can attach to an insert. Kept open as a record
 * because the keys differ per category (e.g. `going_through` carries
 * `{situation: "divorce"}`; `health` may carry `{condition: "asthma",
 * pattern: "recurring"}`). The extractor prompt enumerates the expected
 * keys per category — runtime keeps this loose to avoid blocking valid
 * insertions on schema drift.
 */
const StructuredFieldsSchema = z.record(z.string(), z.unknown());
const KeywordsSchema = z.array(z.string().min(1)).max(16).optional();

const AddDurableOpSchema = z.object({
	op: z.literal("add_durable"),
	claim: z.string().min(1),
	category: DurableCategoryEnum,
	structured_fields: StructuredFieldsSchema,
	keywords: KeywordsSchema,
	verification_status: VerificationStatusEnum.optional(),
	reason: z.string().optional(),
});

const AddCurrentOpSchema = z.object({
	op: z.literal("add_current"),
	claim: z.string().min(1),
	category: CurrentCategoryEnum,
	structured_fields: StructuredFieldsSchema,
	keywords: KeywordsSchema,
	/**
	 * ISO timestamp of when the state began. Optional in the schema because
	 * the extractor defaults to `now` when the model omits it.
	 */
	valid_at: z.string().optional(),
	reason: z.string().optional(),
});

const StrengthenOpSchema = z.object({
	op: z.literal("strengthen"),
	factId: z.string().min(1),
	reason: z.string().optional(),
});

const DecayOpSchema = z.object({
	op: z.literal("decay"),
	factId: z.string().min(1),
	reason: z.string().optional(),
});

const ContradictOpSchema = z.object({
	op: z.literal("contradict"),
	factId: z.string().min(1),
	/**
	 * The replacement claim, when the user supplied one inline (e.g. "actually
	 * I moved to Tokyo"). Optional — `contradict` without a replacement just
	 * queues the existing fact for review.
	 */
	proposedText: z.string().optional(),
	reason: z.string().min(1),
});

/**
 * Discriminated union of every op the extractor may emit, keyed on `op`.
 */
export const OpSchema = z.discriminatedUnion("op", [
	AddDurableOpSchema,
	AddCurrentOpSchema,
	StrengthenOpSchema,
	DecayOpSchema,
	ContradictOpSchema,
]);

export type AddDurableOp = z.infer<typeof AddDurableOpSchema>;
export type AddCurrentOp = z.infer<typeof AddCurrentOpSchema>;
export type StrengthenOp = z.infer<typeof StrengthenOpSchema>;
export type DecayOp = z.infer<typeof DecayOpSchema>;
export type ContradictOp = z.infer<typeof ContradictOpSchema>;
export type ExtractorOp = z.infer<typeof OpSchema>;

/**
 * Top-level shape the extractor LLM must return: one structured object with
 * a single `ops` field.
 */
export const ExtractorOutputSchema = z.object({
	ops: z.array(OpSchema),
});

export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;
