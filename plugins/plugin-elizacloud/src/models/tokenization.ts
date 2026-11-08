import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/host/protocol";
import { ModelType } from "@elizaos/core";
import { getEncodingNameForModel, Tiktoken } from "js-tiktoken/lite";
import { type DetokenizeTextParams } from "@elizaos/core";
import { type IAgentRuntime } from "@elizaos/core";
import { type ModelTypeName } from "@elizaos/core";
import { type ProcessEnvLike } from "@elizaos/core";
import { type TokenizeTextParams } from "@elizaos/core";
import { type TiktokenBPE, type TiktokenEncoding, type TiktokenModel } from "js-tiktoken/lite";
function getProcessEnv(): ProcessEnvLike {
    if (typeof process === "undefined") {
        return {};
    }
    return process.env as ProcessEnvLike;
}
const env = getProcessEnv();
function getConfiguredTokenizerModel(model: ModelTypeName): string {
    return model === ModelType.TEXT_SMALL
        ? (env.ELIZAOS_CLOUD_SMALL_MODEL ?? env.SMALL_MODEL ?? DEFAULT_ELIZA_CLOUD_TEXT_MODEL)
        : (env.ELIZAOS_CLOUD_LARGE_MODEL ?? env.LARGE_MODEL ?? DEFAULT_ELIZA_CLOUD_TEXT_MODEL);
}
function tiktokenCandidates(modelName: string): string[] {
    const slashIndex = modelName.indexOf("/");
    const providerless = slashIndex >= 0 ? modelName.slice(slashIndex + 1) : modelName;
    const baseVariant = providerless.split(":")[0] || providerless;
    return [modelName, providerless, baseVariant, "gpt-4o"];
}
export function resolveTokenizerEncodingName(modelName: string): TiktokenEncoding {
    for (const candidate of tiktokenCandidates(modelName)) {
        try {
            return getEncodingNameForModel(candidate as TiktokenModel);
        }
        catch {
            // Try the next compatible tokenizer name.
        }
    }
    return getEncodingNameForModel("gpt-4o");
}
// Each rank table loads on first use; the root `js-tiktoken` entry would
// inline all six of them at import time.
const rankLoaders: Record<TiktokenEncoding, () => Promise<{ default: TiktokenBPE }>> = {
    cl100k_base: () => import("js-tiktoken/ranks/cl100k_base"),
    o200k_base: () => import("js-tiktoken/ranks/o200k_base"),
    gpt2: () => import("js-tiktoken/ranks/gpt2"),
    r50k_base: () => import("js-tiktoken/ranks/r50k_base"),
    p50k_base: () => import("js-tiktoken/ranks/p50k_base"),
    p50k_edit: () => import("js-tiktoken/ranks/p50k_edit"),
};
// A built Tiktoken holds about 69 MB of heap for o200k_base (measured under
// Node; the rank module itself is 2.4 MB and stays in the module cache).
// Keep at most one encoder, and only while calls keep coming: it is dropped
// after ENCODER_IDLE_MS without a call, so one tokenizer request does not pin
// the parsed table for the life of the process.
export const ENCODER_IDLE_MS = 30_000;
let cached: { encoding: TiktokenEncoding; encoder: Promise<Tiktoken> } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function releaseEncoder(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    cached = null;
}
function scheduleRelease(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(releaseEncoder, ENCODER_IDLE_MS);
    (idleTimer as { unref?: () => void }).unref?.();
}
export function loadTokenizerEncoding(encoding: TiktokenEncoding): Promise<Tiktoken> {
    if (cached?.encoding !== encoding) {
        const encoder = rankLoaders[encoding]().then((ranks) => new Tiktoken(ranks.default));
        const entry = { encoding, encoder };
        // A failed load is not cached, so the next call can try again.
        encoder.catch(() => {
            if (cached === entry) {
                releaseEncoder();
            }
        });
        cached = entry;
    }
    scheduleRelease();
    return cached.encoder;
}
/** The encoding whose encoder is held right now, if any, for tests and diagnostics. */
export function loadedTokenizerEncodings(): TiktokenEncoding[] {
    return cached ? [cached.encoding] : [];
}
function encoderFor(model: ModelTypeName): Promise<Tiktoken> {
    return loadTokenizerEncoding(resolveTokenizerEncodingName(getConfiguredTokenizerModel(model)));
}
async function tokenizeText(model: ModelTypeName, prompt: string): Promise<number[]> {
    return (await encoderFor(model)).encode(prompt);
}
async function detokenizeText(model: ModelTypeName, tokens: number[]): Promise<string> {
    return (await encoderFor(model)).decode(tokens);
}
export async function handleTokenizerEncode(_runtime: IAgentRuntime, { prompt, modelType = ModelType.TEXT_LARGE }: TokenizeTextParams): Promise<number[]> {
    return await tokenizeText(modelType ?? ModelType.TEXT_LARGE, prompt);
}
export async function handleTokenizerDecode(_runtime: IAgentRuntime, { tokens, modelType = ModelType.TEXT_LARGE }: DetokenizeTextParams): Promise<string> {
    return await detokenizeText(modelType ?? ModelType.TEXT_LARGE, tokens);
}
