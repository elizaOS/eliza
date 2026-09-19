/**
 * Sends explicitly requested, server-side TypeSafe decisions through the public
 * System One HTTP contract. This adapter is not registered with the runtime and
 * never generates chat replies, authorizes actions, retries, or truncates state.
 */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

export type TypeSafeJson =
  | string
  | number
  | boolean
  | null
  | TypeSafeJson[]
  | { [key: string]: TypeSafeJson };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJson(
  value: unknown,
  ancestors = new Set<object>(),
): value is TypeSafeJson {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const valid =
    keys.every((key) => {
      if (Array.isArray(value) && key === "length") return true;
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return (
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        isJson(descriptor.value, ancestors)
      );
    }) &&
    (!Array.isArray(value) ||
      (Object.keys(value).length === value.length &&
        Object.keys(value).every((key, index) => key === String(index))));
  ancestors.delete(value);
  return valid;
}

// Zod's record parser omits own __proto__ entries. Validate dictionaries without
// rebuilding them so every caller/provider key keeps its original value.
function dictionary<Schema extends z.ZodType>(schema: Schema) {
  return z.custom<Record<string, z.output<Schema>>>(
    (value) =>
      isRecord(value) &&
      Object.values(value).every((item) => schema.safeParse(item).success),
  );
}

const entrySchema = z.union([
  z.string(),
  dictionary(z.custom<TypeSafeJson>((value) => isJson(value))),
  z.array(z.custom<TypeSafeJson>((value) => isJson(value))),
]);
const questionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("choice"),
    instructions: entrySchema,
    criteria: dictionary(z.string().nullable()).refine(
      (criteria) => Object.keys(criteria).length > 0,
    ),
  }),
  z.strictObject({
    type: z.literal("score"),
    instructions: entrySchema,
    criteria: z.array(z.string()).min(2),
  }),
  z.strictObject({
    type: z.literal("noul"),
    instructions: entrySchema,
    criteria: z
      .strictObject({
        true: z.string().optional(),
        false: z.string().optional(),
      })
      .optional(),
  }),
]);
const requestSchema = z.strictObject({
  state: entrySchema,
  model: z
    .string()
    .min(1)
    .refine((model) => model.trim().length > 0),
  questions: dictionary(questionSchema).refine(
    (questions) => Object.keys(questions).length > 0,
  ),
});
const probabilitySchema = z.number().min(0).max(1);
const probabilitiesSchema = dictionary(probabilitySchema);
const answerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: probabilitySchema,
    probabilities: probabilitiesSchema,
  }),
  z.strictObject({
    type: z.literal("score"),
    score: z.number().nonnegative(),
    confidence: probabilitySchema,
    legend: dictionary(z.string()),
    probabilities: probabilitiesSchema,
  }),
  z.strictObject({ type: z.literal("noul"), noul: probabilitySchema }),
]);
const responseSchema = z.strictObject({
  model: z.string().min(1),
  answers: dictionary(answerSchema),
  usage: z.strictObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export type TypeSafeQuestion = z.infer<typeof questionSchema>;
export type TypeSafeDecisionRequest = z.infer<typeof requestSchema>;
export type TypeSafeAnswer = z.infer<typeof answerSchema>;
export type TypeSafeDecisionResponse = z.infer<typeof responseSchema>;

export interface TypeSafeDecisionClientOptions {
  /** Explicit server-held credential; the client never reads environment keys. */
  apiKey: string;
  /** Complete evaluation URL; custom endpoints must also use HTTPS. */
  endpoint?: string;
  /** Total transport/body budget, 1–60,000 ms; defaults to 10,000 ms. */
  timeoutMs?: number;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

function failure(code: string, message: string, status?: number): ElizaError {
  return new ElizaError(message, {
    code: `TYPESAFE_${code}`,
    ...(status === undefined ? {} : { context: { status } }),
  });
}

function sameKeys(left: object, right: object): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key))
  );
}

function validateResponse(
  value: unknown,
  request: TypeSafeDecisionRequest,
): TypeSafeDecisionResponse {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success || !sameKeys(parsed.data.answers, request.questions)) {
    throw failure(
      "INVALID_RESPONSE",
      "TypeSafe returned an unsupported response contract.",
    );
  }
  for (const [key, question] of Object.entries(request.questions)) {
    const answer = parsed.data.answers[key];
    if (!answer || answer.type !== question.type) {
      throw failure(
        "INVALID_RESPONSE",
        "TypeSafe answer types do not match the questions.",
      );
    }
    if (question.type === "choice" && answer.type === "choice") {
      if (
        !Object.hasOwn(question.criteria, answer.choice) ||
        !sameKeys(answer.probabilities, question.criteria)
      ) {
        throw failure(
          "INVALID_RESPONSE",
          "TypeSafe choice options do not match the question.",
        );
      }
    }
    if (question.type === "score" && answer.type === "score") {
      const legend = Object.fromEntries(
        question.criteria.map((label, index) => [index, label]),
      );
      if (
        !sameKeys(answer.legend, legend) ||
        !sameKeys(answer.probabilities, legend) ||
        Object.entries(legend).some(
          ([level, label]) => answer.legend[level] !== label,
        ) ||
        answer.score > question.criteria.length - 1
      ) {
        throw failure(
          "INVALID_RESPONSE",
          "TypeSafe score levels do not match the question.",
        );
      }
    }
    if (answer.type !== "noul") {
      const sum = Object.values(answer.probabilities).reduce(
        (total, value) => total + value,
        0,
      );
      if (Math.abs(sum - 1) > 0.0001) {
        throw failure(
          "INVALID_RESPONSE",
          "TypeSafe probabilities do not form a distribution.",
        );
      }
    }
  }
  return parsed.data;
}

export class TypeSafeDecisionClient {
  #apiKey: string;
  #endpoint: string;
  #timeoutMs: number;
  #fetch: NonNullable<TypeSafeDecisionClientOptions["fetch"]>;

  constructor(options: TypeSafeDecisionClientOptions) {
    if (typeof window !== "undefined") {
      throw failure(
        "SERVER_ONLY",
        "TypeSafe credentials must remain on the server.",
      );
    }
    if (
      typeof options.apiKey !== "string" ||
      !options.apiKey.trim() ||
      /[\r\n]/.test(options.apiKey)
    ) {
      throw failure("CONFIG", "TypeSafe requires an explicit API key.");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(
        options.endpoint ?? "https://api.typesafe.ai/v1/systemone",
      );
    } catch {
      // error-policy:J1 Do not retain a URL parser error containing credentials.
      throw failure("CONFIG", "TypeSafe requires a valid HTTPS endpoint.");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw failure(
        "CONFIG",
        "TypeSafe requires HTTPS without URL credentials, queries, or fragments.",
      );
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw failure(
        "CONFIG",
        "TypeSafe timeout must be an integer from 1 to 60000 ms.",
      );
    }
    this.#apiKey = options.apiKey;
    this.#endpoint = endpoint.href;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Evaluate independent typed questions without changing the active provider. */
  async systemOne(
    request: TypeSafeDecisionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<TypeSafeDecisionResponse> {
    if (options.signal?.aborted) {
      throw failure("CANCELLED", "TypeSafe request was cancelled.");
    }
    let body: string;
    let validated: TypeSafeDecisionRequest;
    try {
      if (!isJson(request)) {
        throw failure(
          "INVALID_REQUEST",
          "TypeSafe requires JSON values without coercion.",
        );
      }
      body = JSON.stringify(request);
      validated = requestSchema.parse(JSON.parse(body));
    } catch {
      // error-policy:J1 Schema/serialization errors can contain private state.
      throw failure(
        "INVALID_REQUEST",
        "TypeSafe requires a complete JSON state and supported questions.",
      );
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          timedOut
            ? failure("TIMEOUT", "TypeSafe request exceeded its time budget.")
            : failure("CANCELLED", "TypeSafe request was cancelled."),
        );
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        this.#send(body, validated, controller.signal),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async #send(
    body: string,
    request: TypeSafeDecisionRequest,
    signal: AbortSignal,
  ): Promise<TypeSafeDecisionResponse> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal,
        redirect: "error",
        credentials: "omit",
      });
    } catch {
      // error-policy:J1 Transport errors may echo headers, URLs, or request state.
      throw failure(
        "TRANSPORT",
        "TypeSafe transport failed; no automatic retry was made.",
      );
    }
    if (!response.ok) {
      // The provider's error body may echo private inputs; do not read or expose it.
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // error-policy:J1 Preserve the HTTP failure without exposing stream errors.
          throw failure(
            "HTTP",
            "TypeSafe rejected the request; inspect the HTTP status.",
            response.status,
          );
        }
      }
      throw failure(
        "HTTP",
        "TypeSafe rejected the request; inspect the HTTP status.",
        response.status,
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      // error-policy:J1 Invalid JSON/body failures must not retain provider text.
      throw failure(
        "INVALID_RESPONSE",
        "TypeSafe did not return a complete JSON response.",
      );
    }
    return validateResponse(value, request);
  }
}
