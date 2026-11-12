/**
 * Exact BPE wrappers for offline token math — encode/decode/count
 * keyed to a runtime model slot. Resolves the tiktoken encoding from the model
 * name, falling back to o200k_base for 4o-family models else cl100k_base.
 *
 * Each encoding's rank table is loaded on first use and cached, so importing
 * this module (or the plugin) builds no encoder; only the encodings a model
 * actually asks for are ever held in memory.
 */
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import {
  getEncodingNameForModel,
  type TiktokenEncoding,
  type TiktokenModel,
} from "js-tiktoken/lite";
import { getLargeModel, getSmallModel } from "./config";

type SupportedEncoding = "cl100k_base" | "o200k_base";

/** The encode/decode surface every gpt-tokenizer encoding module exports. */
export interface BpeEncoder {
  encode(text: string): number[];
  decode(tokens: Iterable<number>): string;
}

const encoderLoaders = {
  cl100k_base: () => import("gpt-tokenizer/encoding/cl100k_base"),
  o200k_base: () => import("gpt-tokenizer/encoding/o200k_base"),
  gpt2: () => import("gpt-tokenizer/encoding/gpt2"),
  r50k_base: () => import("gpt-tokenizer/encoding/r50k_base"),
  p50k_base: () => import("gpt-tokenizer/encoding/p50k_base"),
  p50k_edit: () => import("gpt-tokenizer/encoding/p50k_edit"),
} satisfies Record<TiktokenEncoding, () => Promise<{ default: BpeEncoder }>>;

const loadedEncoders = new Map<TiktokenEncoding, Promise<BpeEncoder>>();

/** Loads one encoding on first use; later calls share the same encoder. */
export function loadEncoder(encoding: TiktokenEncoding): Promise<BpeEncoder> {
  let pending = loadedEncoders.get(encoding);
  if (!pending) {
    pending = encoderLoaders[encoding]().then((module) => module.default);
    // A failed load is not cached, so the next call can try again.
    pending.catch(() => loadedEncoders.delete(encoding));
    loadedEncoders.set(encoding, pending);
  }
  return pending;
}

/** The encodings loaded (or loading) so far, for tests and diagnostics. */
export function loadedEncodingNames(): TiktokenEncoding[] {
  return [...loadedEncoders.keys()];
}

export function resolveTokenizerEncodingName(modelName: string): TiktokenEncoding {
  const normalized = modelName.toLowerCase();
  const fallbackEncoding: SupportedEncoding = normalized.includes("4o")
    ? "o200k_base"
    : "cl100k_base";
  try {
    return getEncodingNameForModel(modelName as TiktokenModel);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — js-tiktoken throws on model
    // names outside its static registry (custom/newer models); fall back to the
    // closest base encoding so token estimates stay usable instead of throwing.
    return fallbackEncoding;
  }
}

function getModelName(runtime: IAgentRuntime, modelType: ModelTypeName): string {
  if (modelType === ModelType.TEXT_SMALL) {
    return getSmallModel(runtime);
  }
  return getLargeModel(runtime);
}

function encoderFor(runtime: IAgentRuntime, modelType: ModelTypeName): Promise<BpeEncoder> {
  return loadEncoder(resolveTokenizerEncodingName(getModelName(runtime, modelType)));
}

export async function tokenizeText(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  text: string
): Promise<number[]> {
  return (await encoderFor(runtime, modelType)).encode(text);
}

export async function detokenizeText(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  tokens: number[]
): Promise<string> {
  return (await encoderFor(runtime, modelType)).decode(tokens);
}

export async function countTokens(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  text: string
): Promise<number> {
  return (await tokenizeText(runtime, modelType, text)).length;
}
