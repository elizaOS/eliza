import { z } from "zod";

export const SCRATCHPAD_MAX_TOPICS = 10;
export const SCRATCHPAD_TOPIC_TOKEN_LIMIT = 8_000;
export const SCRATCHPAD_APPROX_CHARS_PER_TOKEN = 4;
export const SCRATCHPAD_TOPIC_TITLE_MAX_LENGTH = 120;
export const SCRATCHPAD_TOPIC_SUMMARY_MAX_LENGTH = 240;
export const SCRATCHPAD_SEARCH_QUERY_MAX_LENGTH = 500;

export function estimateScratchpadTokenCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0
    ? 0
    : Math.ceil(trimmed.length / SCRATCHPAD_APPROX_CHARS_PER_TOKEN);
}

export const scratchpadTopicTitleSchema = z
  .string()
  .trim()
  .min(1, "title is required")
  .max(SCRATCHPAD_TOPIC_TITLE_MAX_LENGTH);

export const scratchpadTopicTextSchema = z
  .string()
  .trim()
  .min(1, "text is required")
  .refine(
    (text) =>
      estimateScratchpadTokenCount(text) <= SCRATCHPAD_TOPIC_TOKEN_LIMIT,
    `text exceeds ${SCRATCHPAD_TOPIC_TOKEN_LIMIT} approximate tokens`,
  );

export const scratchpadTopicSummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(SCRATCHPAD_TOPIC_SUMMARY_MAX_LENGTH);

export const scratchpadTopicDtoSchema = z.object({
  id: z.string().min(1),
  title: scratchpadTopicTitleSchema,
  text: z.string().min(1),
  tokenCount: z.number().int().min(1).max(SCRATCHPAD_TOPIC_TOKEN_LIMIT),
  summary: scratchpadTopicSummarySchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  fragmentCount: z.number().int().nonnegative(),
});

export const scratchpadCreateTopicRequestSchema = z.object({
  title: scratchpadTopicTitleSchema,
  text: scratchpadTopicTextSchema,
  summary: scratchpadTopicSummarySchema.optional(),
});

export const scratchpadReplaceTopicRequestSchema =
  scratchpadCreateTopicRequestSchema;

export const scratchpadSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, "q is required")
    .max(SCRATCHPAD_SEARCH_QUERY_MAX_LENGTH),
  limit: z.coerce.number().int().min(1).max(SCRATCHPAD_MAX_TOPICS).optional(),
});

export const scratchpadTopicMatchDtoSchema = z.object({
  fragmentId: z.string().min(1),
  text: z.string(),
  score: z.number().min(0),
  position: z.number().int().nonnegative().optional(),
});

export const scratchpadTopicSearchResultDtoSchema = z.object({
  topic: scratchpadTopicDtoSchema,
  score: z.number().min(0),
  matches: z.array(scratchpadTopicMatchDtoSchema),
});

export const scratchpadTopicsListResponseSchema = z.object({
  topics: z.array(scratchpadTopicDtoSchema),
  count: z.number().int().nonnegative(),
  maxTopics: z.literal(SCRATCHPAD_MAX_TOPICS),
  maxTokensPerTopic: z.literal(SCRATCHPAD_TOPIC_TOKEN_LIMIT),
});

export const scratchpadTopicResponseSchema = z.object({
  topic: scratchpadTopicDtoSchema,
});

export const scratchpadDeleteTopicResponseSchema = z.object({
  ok: z.literal(true),
  topicId: z.string().min(1),
  deletedFragments: z.number().int().nonnegative(),
});

export const scratchpadSearchResponseSchema = z.object({
  query: z.string().min(1),
  results: z.array(scratchpadTopicSearchResultDtoSchema),
  count: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(SCRATCHPAD_MAX_TOPICS),
});

export const scratchpadSummaryPreviewRequestSchema = z.object({
  text: scratchpadTopicTextSchema,
});

export const scratchpadSummaryPreviewResponseSchema = z.object({
  summary: scratchpadTopicSummarySchema,
  tokenCount: z.number().int().min(1).max(SCRATCHPAD_TOPIC_TOKEN_LIMIT),
});

export type ScratchpadTopicDto = z.infer<typeof scratchpadTopicDtoSchema>;
export type ScratchpadCreateTopicRequest = z.infer<
  typeof scratchpadCreateTopicRequestSchema
>;
export type ScratchpadReplaceTopicRequest = z.infer<
  typeof scratchpadReplaceTopicRequestSchema
>;
export type ScratchpadSearchQuery = z.infer<typeof scratchpadSearchQuerySchema>;
export type ScratchpadTopicMatchDto = z.infer<
  typeof scratchpadTopicMatchDtoSchema
>;
export type ScratchpadTopicSearchResultDto = z.infer<
  typeof scratchpadTopicSearchResultDtoSchema
>;
export type ScratchpadTopicsListResponse = z.infer<
  typeof scratchpadTopicsListResponseSchema
>;
export type ScratchpadTopicResponse = z.infer<
  typeof scratchpadTopicResponseSchema
>;
export type ScratchpadDeleteTopicResponse = z.infer<
  typeof scratchpadDeleteTopicResponseSchema
>;
export type ScratchpadSearchResponse = z.infer<
  typeof scratchpadSearchResponseSchema
>;
export type ScratchpadSummaryPreviewRequest = z.infer<
  typeof scratchpadSummaryPreviewRequestSchema
>;
export type ScratchpadSummaryPreviewResponse = z.infer<
  typeof scratchpadSummaryPreviewResponseSchema
>;
