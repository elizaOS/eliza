/**
 * Zod schemas for miscellaneous HTTP routes — share intake, emote
 * trigger, agent event ingest, terminal run, and custom-actions CRUD.
 *
 * Routes covered (body-bearing only — /api/restart and the GET
 * variants don't read a body):
 *
 *   POST /api/ingest/share        { source?, title?, url?, text? }
 *   POST /api/emote               { emoteId? }
 *   POST /api/agent/event         { stream, data?, roomId? }
 *   POST /api/terminal/run        { command, clientId?, terminalToken?,
 *                                   captureOutput? }
 *   POST /api/custom-actions      (full CustomActionDef create body)
 *   POST /api/custom-actions/generate { prompt }
 *   POST /api/custom-actions/:id/test  { params? }
 *   PUT  /api/custom-actions/:id  (partial update — handler is the only
 *                                   discriminated field; everything else is
 *                                   optional and falls back to existing values)
 */

import z from "zod";

// ---------------------------------------------------------------------------
// share intake / emote / agent event
// ---------------------------------------------------------------------------

/**
 * Share intake from OS share-sheets / browser-extension etc. Every
 * field is optional; the handler builds a suggested prompt from
 * whichever fields are present. Keep the schema lenient.
 */
export const PostIngestShareRequestSchema = z
  .object({
    source: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    text: z.string().optional(),
  })
  .strict();

export const PostEmoteRequestSchema = z
  .object({
    emoteId: z.string().optional(),
  })
  .strict();

export const PostAgentEventRequestSchema = z
  .object({
    stream: z.string().regex(/\S/, "stream is required"),
    data: z.record(z.string(), z.unknown()).optional(),
    roomId: z.string().optional(),
  })
  .strict()
  .transform((value) => ({
    stream: value.stream.trim(),
    ...(value.data !== undefined ? { data: value.data } : {}),
    ...(value.roomId?.trim() ? { roomId: value.roomId.trim() } : {}),
  }));

// ---------------------------------------------------------------------------
// terminal/run
// ---------------------------------------------------------------------------

/**
 * Terminal command execution. `clientId` is intentionally `unknown` at
 * the wire — `resolveTerminalRunClientId` accepts string, number, or
 * structured wrappers for compatibility with multiple call sites.
 * The other invariants (single-line, max 4096 chars, control chars)
 * are checked in the handler since they share the rejection path with
 * other mechanisms.
 */
export const PostTerminalRunRequestSchema = z
  .object({
    command: z.string(),
    clientId: z.unknown().optional(),
    terminalToken: z.string().optional(),
    captureOutput: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// custom actions
// ---------------------------------------------------------------------------

const CustomActionParameterSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    required: z.boolean(),
  })
  .strict();

const CustomActionHttpHandlerSchema = z
  .object({
    type: z.literal("http"),
    method: z.string(),
    url: z.string().regex(/\S/, "HTTP handler requires a url"),
    headers: z.record(z.string(), z.string()).optional(),
    bodyTemplate: z.string().optional(),
  })
  .strict();

const CustomActionShellHandlerSchema = z
  .object({
    type: z.literal("shell"),
    command: z.string().regex(/\S/, "Shell handler requires a command"),
  })
  .strict();

const CustomActionCodeHandlerSchema = z
  .object({
    type: z.literal("code"),
    code: z.string().regex(/\S/, "Code handler requires code"),
  })
  .strict();

export const CustomActionHandlerSchema = z.discriminatedUnion("type", [
  CustomActionHttpHandlerSchema,
  CustomActionShellHandlerSchema,
  CustomActionCodeHandlerSchema,
]);

export const PostCustomActionRequestSchema = z
  .object({
    name: z.string().regex(/\S/, "name is required"),
    description: z.string().regex(/\S/, "description is required"),
    similes: z.array(z.string()).optional(),
    parameters: z.array(CustomActionParameterSchema).optional(),
    handler: CustomActionHandlerSchema,
    enabled: z.boolean().optional(),
  })
  .strict()
  .transform((value) => ({
    name: value.name.trim(),
    description: value.description.trim(),
    similes: value.similes ?? [],
    parameters: value.parameters ?? [],
    handler: value.handler,
    enabled: value.enabled !== false,
  }));

export const PostCustomActionGenerateRequestSchema = z
  .object({
    prompt: z.string().regex(/\S/, "prompt is required"),
  })
  .strict()
  .transform((value) => ({
    prompt: value.prompt.trim(),
  }));

export const PostCustomActionTestRequestSchema = z
  .object({
    params: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * PUT update — every field optional, handler optional but if present
 * must be a full discriminated handler. Existing handler is preserved
 * server-side when this field is absent.
 */
export const PutCustomActionRequestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    similes: z.array(z.string()).optional(),
    parameters: z.array(CustomActionParameterSchema).optional(),
    handler: CustomActionHandlerSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type PostIngestShareRequest = z.infer<
  typeof PostIngestShareRequestSchema
>;
export type PostEmoteRequest = z.infer<typeof PostEmoteRequestSchema>;
export type PostAgentEventRequest = z.infer<typeof PostAgentEventRequestSchema>;
export type PostTerminalRunRequest = z.infer<
  typeof PostTerminalRunRequestSchema
>;
export type PostCustomActionRequest = z.infer<
  typeof PostCustomActionRequestSchema
>;
export type PostCustomActionGenerateRequest = z.infer<
  typeof PostCustomActionGenerateRequestSchema
>;
export type PostCustomActionTestRequest = z.infer<
  typeof PostCustomActionTestRequestSchema
>;
export type PutCustomActionRequest = z.infer<
  typeof PutCustomActionRequestSchema
>;
