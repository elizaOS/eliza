// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Ollama provider for chat completion.
 *
 * Per locked decision #21, the local Llama-3.2-1B handles every conversation
 * before any cloud auth. We talk to it via Ollama's HTTP API at
 * 127.0.0.1:11434 — Ollama runs as a systemd service in the qcow2 / live
 * ISO (vm/disk-base/overlay/etc/systemd/system/ollama.service.d/override.conf).
 *
 * This module is the *real* model provider Eliza uses for chat fallthrough.
 * The codegen path (build me X) keeps using Claude Code via `claude --print`
 * — a 1B model can't reliably generate working apps, but it can hold a
 * warm conversation, which is what calibration + early-boot UX needs.
 *
 * Wire shape mirrors Ollama's own /api/chat: messages array of
 * {role: "system" | "user" | "assistant", content: string}.
 */

export interface OllamaMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface OllamaChatRequest {
    model: string;
    messages: OllamaMessage[];
    stream?: false;
}

export interface OllamaChatResponse {
    model: string;
    message: { role: "assistant"; content: string };
    done: boolean;
}

export interface OllamaProviderOptions {
    /** HTTP base URL for Ollama. Defaults to env or 127.0.0.1:11434. */
    baseUrl?: string;
    /** Model identifier. Defaults to env or `llama3.2:1b`. */
    model?: string;
    /** Per-request timeout (ms). Default: 60s. Local 1B replies in ~500-2000ms. */
    timeoutMs?: number;
    /** Test/CI seam: replace the fetch impl. */
    fetchImpl?: typeof fetch;
}

export class OllamaError extends Error {
    public readonly code: "unreachable" | "http" | "timeout" | "schema";
    constructor(message: string, code: OllamaError["code"], cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "OllamaError";
        this.code = code;
    }
}

/** Resolve the Ollama base URL freshly on every call so test seams that
 *  mutate `Bun.env.USBELIZA_OLLAMA_URL` (or the `OLLAMA_HOST` legacy alias)
 *  before invoking the handler get the override they expect. */
function resolveBaseUrl(): string {
    const explicit = Bun.env.USBELIZA_OLLAMA_URL ?? Bun.env.OLLAMA_HOST;
    if (typeof explicit === "string" && explicit.length > 0) {
        return explicit.startsWith("http") ? explicit : `http://${explicit}`;
    }
    return "http://127.0.0.1:11434";
}

function resolveModel(): string {
    return Bun.env.USBELIZA_OLLAMA_MODEL ?? "llama3.2:1b";
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Probe Ollama for liveness. Returns true iff /api/version responds 200. */
export async function isOllamaReachable(
    options: OllamaProviderOptions = {},
): Promise<boolean> {
    const baseUrl = options.baseUrl ?? resolveBaseUrl();
    const fetchFn = options.fetchImpl ?? fetch;
    try {
        const response = await fetchFn(`${baseUrl}/api/version`, {
            method: "GET",
            signal: AbortSignal.timeout(2000),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/** Send a chat completion to Ollama. Throws OllamaError on any failure. */
export async function ollamaChat(
    request: OllamaChatRequest,
    options: OllamaProviderOptions = {},
): Promise<OllamaChatResponse> {
    const baseUrl = options.baseUrl ?? resolveBaseUrl();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = options.fetchImpl ?? fetch;

    let response: Response;
    try {
        response = await fetchFn(`${baseUrl}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...request, stream: false }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (cause) {
        const err = cause as { name?: string };
        if (err?.name === "TimeoutError") {
            throw new OllamaError(
                `Ollama did not respond within ${timeoutMs}ms`,
                "timeout",
                cause,
            );
        }
        throw new OllamaError(
            `Ollama at ${baseUrl} is unreachable: ${(cause as Error).message}`,
            "unreachable",
            cause,
        );
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new OllamaError(
            `Ollama returned HTTP ${response.status}: ${body.slice(0, 400)}`,
            "http",
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch (cause) {
        throw new OllamaError("Ollama reply was not JSON", "schema", cause);
    }

    if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as OllamaChatResponse).message?.content !== "string"
    ) {
        throw new OllamaError(
            "Ollama reply missing message.content",
            "schema",
        );
    }
    return body as OllamaChatResponse;
}

/** Convenience: one-shot chat with a system prompt + user turn. */
export async function ollamaCompleteOneShot(
    systemPrompt: string,
    userMessage: string,
    options: OllamaProviderOptions = {},
): Promise<string> {
    const response = await ollamaChat(
        {
            model: options.model ?? resolveModel(),
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage },
            ],
        },
        options,
    );
    return response.message.content.trim();
}

export const __test = { resolveBaseUrl, resolveModel };
