export type CloudJsonValue = null | string | number | boolean | CloudJsonObject | CloudJsonValue[];

export type CloudJsonObject = {
  [key: string]: CloudJsonValue | undefined;
};

/**
 * Shape of merged `providerOptions` passed into AI SDK calls (`streamText`, forwarded bodies).
 *
 * **Why `Record<string, JSONObject>`:** Aligns with AI SDK shared provider options so nested
 * `anthropic` and `google` fragments stay JSON-serializable and assignable without `any`.
 * **Why a dedicated type:** `anthropic-thinking.ts` merges fragments from several routes; one alias
 * keeps merges consistent and documents intent at call sites.
 */
export type CloudMergedProviderOptions = Record<string, CloudJsonObject>;
