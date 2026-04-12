/**
 * Wrap `AxAIService.chat` for Phase 4 learning: append one JSON line per call to
 * `instrumentation.jsonl` under the model/slot directory (next to `history.jsonl`).
 *
 * **WHY at the Ax layer:** Logs exactly what GEPA/ACE send to the provider and
 * what comes back — the right boundary for cost accounting and for replacing Ax
 * with a native optimizer later.
 *
 * **WHY not wrap `embed`:** GEPA/ACE paths in this codebase do not rely on
 * embeddings from these service instances; logging embed calls would add noise.
 *
 * **WHY levels:** `full` maximizes research value; `summary` / `minimal` reduce
 * PII and size; `off` avoids disk I/O when operators only want artifacts.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	AxAIService,
	AxAIServiceOptions,
	AxChatRequest,
	AxChatResponse,
	AxEmbedRequest,
	AxEmbedResponse,
	AxLoggerFunction,
	AxModelConfig,
} from "@ax-llm/ax";
import type { OptimizationAIConfig } from "./optimization-ai.ts";
import { createStudentAI, createTeacherAI } from "./optimization-ai.ts";

export type InstrumentationLevel = "full" | "summary" | "minimal" | "off";

export function parseInstrumentationLevel(raw: unknown): InstrumentationLevel {
	if (typeof raw !== "string") return "full";
	const v = raw.trim().toLowerCase();
	if (v === "summary" || v === "minimal" || v === "off") return v;
	return "full";
}

export class InstrumentationLogger {
	constructor(
		private readonly dir: string | undefined,
		private readonly level: InstrumentationLevel,
	) {}

	async log(entry: Record<string, unknown>): Promise<void> {
		if (this.level === "off" || !this.dir) return;
		const line = `${JSON.stringify({ ...entry, level: this.level })}\n`;
		await mkdir(this.dir, { recursive: true });
		await appendFile(join(this.dir, "instrumentation.jsonl"), line, "utf-8");
	}
}

function summarizeChatPrompt(req: Readonly<AxChatRequest>): {
	messageCount: number;
	roles: string[];
	approxChars: number;
	full?: unknown;
} {
	const msgs = req.chatPrompt ?? [];
	let approxChars = 0;
	const roles: string[] = [];
	for (const m of msgs) {
		roles.push(m.role);
		if (m.role === "system" || m.role === "user") {
			const c = m.content;
			if (typeof c === "string") approxChars += c.length;
			else if (Array.isArray(c)) {
				for (const part of c) {
					if (part.type === "text" && "text" in part)
						approxChars += part.text.length;
				}
			}
		} else if (m.role === "assistant") {
			approxChars += (m.content ?? "").length;
		} else if (m.role === "function") {
			approxChars += m.result.length;
		}
	}
	return {
		messageCount: msgs.length,
		roles,
		approxChars,
	};
}

function extractChatText(res: AxChatResponse): string {
	const parts = res.results?.map((r) => r.content ?? "").filter(Boolean) ?? [];
	return parts.join("\n");
}

export class InstrumentedAxAI implements AxAIService {
	constructor(
		private readonly inner: AxAIService,
		private readonly logger: InstrumentationLogger,
		private readonly label: "student" | "teacher",
		private readonly level: InstrumentationLevel,
	) {}

	getId(): string {
		return this.inner.getId();
	}
	getName(): string {
		return this.inner.getName();
	}
	getFeatures(model?: unknown) {
		return this.inner.getFeatures(model as never);
	}
	getModelList() {
		return this.inner.getModelList();
	}
	getMetrics() {
		return this.inner.getMetrics();
	}
	getLogger(): AxLoggerFunction {
		return this.inner.getLogger();
	}
	getLastUsedChatModel() {
		return this.inner.getLastUsedChatModel();
	}
	getLastUsedEmbedModel() {
		return this.inner.getLastUsedEmbedModel();
	}
	getLastUsedModelConfig(): AxModelConfig | undefined {
		return this.inner.getLastUsedModelConfig();
	}
	setOptions(options: Readonly<AxAIServiceOptions>): void {
		this.inner.setOptions(options);
	}
	getOptions(): Readonly<AxAIServiceOptions> {
		return this.inner.getOptions();
	}

	async embed(
		req: Readonly<AxEmbedRequest<string>>,
		options?: Readonly<AxAIServiceOptions>,
	): Promise<AxEmbedResponse> {
		return this.inner.embed(req, options);
	}

	async chat(
		req: Readonly<AxChatRequest<string>>,
		options?: Readonly<AxAIServiceOptions>,
	): Promise<AxChatResponse | ReadableStream<AxChatResponse>> {
		const start = Date.now();
		const result = await this.inner.chat(req, options);
		const latencyMs = Date.now() - start;

		if (this.level === "off") return result;

		const base = {
			ts: new Date(start).toISOString(),
			label: this.label,
			latencyMs,
			modelUsage: undefined as AxChatResponse["modelUsage"] | undefined,
		};

		if (result instanceof ReadableStream) {
			await this.logger.log({
				...base,
				streamed: true,
				prompt: promptPayload(this.level, req),
			});
			return result;
		}

		base.modelUsage = result.modelUsage;
		const text = extractChatText(result);

		if (this.level === "minimal") {
			await this.logger.log({
				...base,
				responseChars: text.length,
			});
		} else if (this.level === "summary") {
			await this.logger.log({
				...base,
				prompt: summarizeChatPrompt(req),
				responseChars: text.length,
			});
		} else {
			await this.logger.log({
				...base,
				promptMessages: req.chatPrompt,
				responseResults: result.results,
				modelUsage: result.modelUsage,
			});
		}

		return result;
	}
}

function promptPayload(
	level: InstrumentationLevel,
	req: Readonly<AxChatRequest>,
) {
	if (level === "full") return req.chatPrompt;
	return summarizeChatPrompt(req);
}

type AxMod = typeof import("@ax-llm/ax");

/**
 * Build instrumented student/teacher services for GEPA/ACE.
 */
export function createInstrumentedOptimizationPair(
	axMod: AxMod,
	aiConfig: OptimizationAIConfig,
	instrumentationDir: string | undefined,
	instrumentationLevel: InstrumentationLevel,
): { studentAI: AxAIService; teacherAI: AxAIService } {
	const student = createStudentAI(axMod, aiConfig);
	const teacher = createTeacherAI(axMod, aiConfig);
	const logger = new InstrumentationLogger(
		instrumentationDir,
		instrumentationLevel,
	);
	return {
		studentAI: new InstrumentedAxAI(
			student,
			logger,
			"student",
			instrumentationLevel,
		),
		teacherAI: new InstrumentedAxAI(
			teacher,
			logger,
			"teacher",
			instrumentationLevel,
		),
	};
}
