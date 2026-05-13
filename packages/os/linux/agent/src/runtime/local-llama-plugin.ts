// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Shaw's llama.cpp stack — a thin @elizaos/core Plugin that maps the
 * canonical `ModelType.TEXT_*` keys to node-llama-cpp inference against a
 * GGUF on disk. No Ollama daemon, no HTTP — just libllama.so + a .gguf
 * model file loaded into the agent process.
 *
 * Why this exists separately from `@elizaos/plugin-local-ai`: that plugin
 * pins `@elizaos/core@2.0.0-alpha.3` (vs our alpha.537) and drags in
 * `@huggingface/transformers` (~1.5GB) + `whisper-node` we don't need.
 * We only need text generation, so we wrap `node-llama-cpp` directly.
 * The same Plugin shape — `models: { TEXT_LARGE: handler }` — that
 * plugin-local-ai uses; runtime.useModel() doesn't care which Plugin owns
 * the handler.
 *
 * Hot-load behavior: the LlamaModel + LlamaContext are constructed lazily
 * on first useModel call (the live ISO boots into chat before any user
 * message, and warming the 1B at boot would gate Plymouth → sway by ~3s).
 * After warmup we keep the context resident.
 *
 * Cross-platform: node-llama-cpp ships prebuilt addon + libllama.so via
 * `@node-llama-cpp/linux-x64{,-vulkan,-cuda}` peer packages. The chroot
 * hook copies these into the squashfs alongside the GGUF, so the live ISO
 * is offline-capable from boot.
 */

import {
    type IAgentRuntime,
    ModelType,
    type Plugin,
} from "@elizaos/core";
import {
    getLlama,
    type Llama,
    LlamaChatSession,
    type LlamaContext,
    type LlamaModel,
} from "node-llama-cpp";
import { existsSync } from "node:fs";

interface TextParams {
    prompt?: string;
    system?: string;
    stopSequences?: string[];
    temperature?: number;
    maxTokens?: number;
}

interface ResolvedModel {
    llama: Llama;
    model: LlamaModel;
    context: LlamaContext;
}

let _resolved: Promise<ResolvedModel> | null = null;

function modelPath(runtime: IAgentRuntime): string {
    // Resolve order matches plugin-local-ai's conventions:
    //   1. Env (USBELIZA_GGUF / LOCAL_LARGE_MODEL) — explicit override.
    //      WINS absolutely: if set, we return it whether or not the file
    //      exists. `resolveModel` surfaces the error to the user. This
    //      lets tests pin a non-existent path to skip the model load.
    //   2. Character settings — bound at boot from env at construction.
    //   3. ISO default — `/usr/share/usbeliza/models/`.
    //   4. Dev fallback — `~/.cache/usbeliza-models/`.
    const explicitEnv = Bun.env.USBELIZA_GGUF ?? Bun.env.LOCAL_LARGE_MODEL;
    if (typeof explicitEnv === "string" && explicitEnv.length > 0) return explicitEnv;

    const explicitSetting =
        runtime.getSetting("LOCAL_LARGE_MODEL") ?? runtime.getSetting("USBELIZA_GGUF");
    if (typeof explicitSetting === "string" && explicitSetting.length > 0) return explicitSetting;

    const iso = "/usr/share/usbeliza/models/llama-3.2-1b-instruct-q4_k_m.gguf";
    if (existsSync(iso)) return iso;

    const home = Bun.env.HOME ?? "/home/eliza";
    return `${home}/.cache/usbeliza-models/llama-3.2-1b-instruct-q4_k_m.gguf`;
}

async function resolveModel(runtime: IAgentRuntime): Promise<ResolvedModel> {
    if (_resolved !== null) return _resolved;
    _resolved = (async () => {
        const path = modelPath(runtime);
        if (!existsSync(path)) {
            throw new Error(
                `usbeliza-local-llama: GGUF not found at ${path}. ` +
                    "On the live ISO the chroot hook bakes one into /usr/share/usbeliza/models/; " +
                    "on a dev machine, run `just iso-cache-model`.",
            );
        }
        const llama = await getLlama({ build: "never" });
        const model = await llama.loadModel({ modelPath: path });
        // sequences=8 lets up to eight chat sessions share the context pool.
        // Each createSession() / generate() call grabs a sequence via
        // `context.getSequence()` and DISPOSES it after the prompt completes —
        // see `generate()` below. Without the dispose, sequences leak and the
        // pool hits "No sequences left" after one (default=1) or eight turns.
        const context = await model.createContext({ contextSize: 4096, sequences: 8 });
        return { llama, model, context };
    })();
    return _resolved;
}

export async function generateViaLocalLlama(
    runtime: IAgentRuntime,
    params: TextParams,
): Promise<string> {
    const { context } = await resolveModel(runtime);
    // Get a fresh sequence per call and dispose it when the prompt completes.
    // Forgetting to dispose leaks the slot until the agent restarts → users
    // see "No sequences left" on the 9th turn (or 2nd, with sequences=1).
    const sequence = context.getSequence();
    try {
        const sessionOpts: ConstructorParameters<typeof LlamaChatSession>[0] = {
            contextSequence: sequence,
        };
        if (typeof params.system === "string" && params.system.length > 0) {
            sessionOpts.systemPrompt = params.system;
        }
        const session = new LlamaChatSession(sessionOpts);

        const prompt = params.prompt ?? "";
        if (prompt.trim().length === 0) return "";

        const response = await session.prompt(prompt, {
            maxTokens: params.maxTokens ?? 512,
            temperature: params.temperature ?? 0.7,
            ...(params.stopSequences !== undefined && params.stopSequences.length > 0
                ? { customStopTriggers: params.stopSequences }
                : {}),
        });
        return response.trim();
    } finally {
        sequence.dispose();
    }
}

export const localLlamaPlugin: Plugin = {
    name: "usbeliza-local-llama",
    description:
        "Shaw's llama.cpp stack — local GGUF inference via node-llama-cpp. " +
        "Replaces the Ollama daemon path; no subprocess, just libllama.so " +
        "loaded into the agent. Backs the chat-fallthrough path when no " +
        "Action matches.",
    models: {
        [ModelType.TEXT_SMALL]: async (runtime, params) =>
            generateViaLocalLlama(runtime, params as unknown as TextParams),
        [ModelType.TEXT_LARGE]: async (runtime, params) =>
            generateViaLocalLlama(runtime, params as unknown as TextParams),
    },
};
