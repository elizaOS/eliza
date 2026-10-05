/**
 * Exact BPE wrappers for offline token math — encode/decode/count
 * keyed to a runtime model slot. Resolves the tiktoken encoding from the model
 * name, falling back to o200k_base for 4o-family models else cl100k_base.
 */
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import cl100k from "gpt-tokenizer/encoding/cl100k_base";
import gpt2 from "gpt-tokenizer/encoding/gpt2";
import o200k from "gpt-tokenizer/encoding/o200k_base";
import p50k from "gpt-tokenizer/encoding/p50k_base";
import p50kEdit from "gpt-tokenizer/encoding/p50k_edit";
import r50k from "gpt-tokenizer/encoding/r50k_base";
import { getEncodingNameForModel, type TiktokenEncoding, type TiktokenModel } from "js-tiktoken";
import { getLargeModel, getSmallModel } from "./config";

type SupportedEncoding = "cl100k_base" | "o200k_base";

const encoders = {
  cl100k_base: cl100k,
  o200k_base: o200k,
  gpt2,
  r50k_base: r50k,
  p50k_base: p50k,
  p50k_edit: p50kEdit,
} satisfies Record<TiktokenEncoding, typeof cl100k>;

function resolveTokenizerEncoding(modelName: string): typeof cl100k {
  const normalized = modelName.toLowerCase();
  const fallbackEncoding: SupportedEncoding = normalized.includes("4o")
    ? "o200k_base"
    : "cl100k_base";
  try {
    return encoders[getEncodingNameForModel(modelName as TiktokenModel)];
  } catch {
    // error-policy:J3 untrusted-input sanitizing — js-tiktoken throws on model
    // names outside its static registry (custom/newer models); fall back to the
    // closest base encoding so token estimates stay usable instead of throwing.
    return encoders[fallbackEncoding];
  }
}

/** Count a provider-prepared request with the concrete selected model. */
export function countTokensForModel(modelName: string, text: string): number {
  return resolveTokenizerEncoding(modelName).encode(text).length;
}

function getModelName(runtime: IAgentRuntime, modelType: ModelTypeName): string {
  if (modelType === ModelType.TEXT_SMALL) {
    return getSmallModel(runtime);
  }
  return getLargeModel(runtime);
}

export function tokenizeText(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  text: string
): number[] {
  const modelName = getModelName(runtime, modelType);
  const encoder = resolveTokenizerEncoding(modelName);
  return encoder.encode(text);
}

export function detokenizeText(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  tokens: number[]
): string {
  const modelName = getModelName(runtime, modelType);
  const encoder = resolveTokenizerEncoding(modelName);
  return encoder.decode(tokens);
}

export function countTokens(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  text: string
): number {
  const tokens = tokenizeText(runtime, modelType, text);
  return tokens.length;
}
