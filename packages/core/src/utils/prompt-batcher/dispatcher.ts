import type { GenerateTextParams } from "../../types/model";
import type { ResolvedSection } from "../../types/prompt-batcher";
import type { IAgentRuntime } from "../../types/runtime";
import {
	type CallPlan,
	createMinimalState,
	type DispatchCallMeta,
	type DispatchOutcome,
	type PromptDispatcherSettings,
	Semaphore,
	sanitizeIdentifier,
} from "./shared";

export class PromptDispatcher {
	constructor(private readonly settings: PromptDispatcherSettings) {}

	async dispatch(
		resolved: ResolvedSection[],
		runtime: IAgentRuntime,
	): Promise<DispatchOutcome> {
		const results = new Map<string, Record<string, unknown>>();
		const calls: DispatchCallMeta[] = [];
		const semaphore = new Semaphore(this.settings.maxParallelCalls);
		const callPlans = this._buildCallPlans(resolved);

		await Promise.all(
			callPlans.map(async (callPlan) => {
				await semaphore.acquire();
				const startedAt = Date.now();
				try {
					const prompt = this._buildPrompt(callPlan);
					const schema = callPlan.sections.flatMap((resolvedSection) => {
						const prefix = sanitizeIdentifier(resolvedSection.section.id);
						return resolvedSection.section.schema.map((row) => ({
							...row,
							field: `${prefix}__${row.field}`,
						}));
					});

					const mergedExecOptions = this._mergeExecOptions(
						callPlan.sections.map((item) => item.execOptions),
					);
					const state = createMinimalState(
						callPlan.sections
							.map(
								(item) =>
									`[${item.section.id}]\n${item.resolvedContext || "[context unavailable]"}`,
							)
							.join("\n\n"),
					);
					const modelSize = callPlan.model;
					const params = {
						prompt,
						...mergedExecOptions,
					} satisfies Omit<GenerateTextParams, "prompt"> & {
						prompt: string;
					};
					const response = await runtime.dynamicPromptExecFromState({
						state,
						params,
						schema,
						options: {
							modelSize,
							key: `prompt-batcher:${callPlan.sections.map((item) => item.section.id).join(",")}`,
						},
					});

					const durationMs = Date.now() - startedAt;
					if (!response) {
						calls.push({
							model: modelSize,
							sectionIds: callPlan.sections.map((item) => item.section.id),
							estimatedTokens: callPlan.totalEstimatedTokens,
							durationMs,
							success: false,
							retried: false,
							fallbackUsed: callPlan.sections.map((item) => item.section.id),
						});
						return;
					}

					for (const section of callPlan.sections) {
						const prefix = `${sanitizeIdentifier(section.section.id)}__`;
						const stripped: Record<string, unknown> = {};
						for (const [key, value] of Object.entries(response)) {
							if (key.startsWith(prefix)) {
								stripped[key.slice(prefix.length)] = value;
							}
						}
						results.set(section.section.id, stripped);
					}

					calls.push({
						model: modelSize,
						sectionIds: callPlan.sections.map((item) => item.section.id),
						estimatedTokens: callPlan.totalEstimatedTokens,
						durationMs,
						success: true,
						retried: false,
						fallbackUsed: [],
					});
				} finally {
					semaphore.release();
				}
			}),
		);

		return { results, calls };
	}

	private _buildCallPlans(resolved: ResolvedSection[]): CallPlan[] {
		const affinityGroups = new Map<string, ResolvedSection[]>();
		for (const section of resolved) {
			const group = affinityGroups.get(section.affinityKey) ?? [];
			group.push(section);
			affinityGroups.set(section.affinityKey, group);
		}

		const callPlans: CallPlan[] = [];
		for (const sections of affinityGroups.values()) {
			for (const priority of ["immediate", "normal", "background"] as const) {
				const prioritized = sections.filter(
					(section) => section.priority === priority,
				);
				if (prioritized.length === 0) {
					continue;
				}

				for (const modelGroup of this._splitByModelPreference(prioritized)) {
					const isolated = modelGroup.sections.filter((item) => item.isolated);
					const packable = modelGroup.sections
						.filter((item) => !item.isolated)
						.sort((a, b) => b.estimatedTokens - a.estimatedTokens);

					for (const item of isolated) {
						callPlans.push({
							sections: [item],
							model: modelGroup.model,
							totalEstimatedTokens: item.estimatedTokens,
							priority,
						});
					}

					const tokenLimit = this._packingTokenLimit(priority);
					let current: ResolvedSection[] = [];
					let tokenCount = 0;
					let fieldCount = 0;

					for (const item of packable) {
						const nextTokens = tokenCount + item.estimatedTokens;
						const nextFieldCount = fieldCount + item.schemaFieldCount;
						const exceedsTokens = nextTokens > tokenLimit;
						const exceedsFields =
							nextFieldCount > this.settings.maxSectionsPerCall;
						const exceedsPromptSafety = nextTokens > 8192;

						if (
							current.length > 0 &&
							(exceedsTokens || exceedsFields || exceedsPromptSafety)
						) {
							callPlans.push({
								sections: current,
								model: modelGroup.model,
								totalEstimatedTokens: tokenCount,
								priority,
							});
							current = [];
							tokenCount = 0;
							fieldCount = 0;
						}

						current.push(item);
						tokenCount += item.estimatedTokens;
						fieldCount += item.schemaFieldCount;
					}

					if (current.length > 0) {
						callPlans.push({
							sections: current,
							model: modelGroup.model,
							totalEstimatedTokens: tokenCount,
							priority,
						});
					}
				}
			}
		}

		return callPlans.sort(
			(a, b) => this._priorityRank(a.priority) - this._priorityRank(b.priority),
		);
	}

	private _splitByModelPreference(sections: ResolvedSection[]): Array<{
		model: "small" | "large";
		sections: ResolvedSection[];
	}> {
		const small = sections.filter(
			(section) => section.preferredModel === "small",
		);
		const large = sections.filter(
			(section) => section.preferredModel === "large",
		);
		if (small.length === 0) {
			return [{ model: "large", sections: large }];
		}
		if (large.length === 0) {
			return [{ model: "small", sections: small }];
		}

		const normalizedSeparation = Math.max(
			0,
			Math.min(1, this.settings.modelSeparation),
		);
		const total = small.length + large.length;
		const smallRatio = small.length / total;
		const promoteSmallIntoLarge = smallRatio < 1 - normalizedSeparation;

		if (promoteSmallIntoLarge) {
			return [
				{
					model: "large",
					sections: [...large, ...small],
				},
			];
		}

		return [
			{ model: "large", sections: large },
			{ model: "small", sections: small },
		];
	}

	private _packingTokenLimit(
		priority: "background" | "normal" | "immediate",
	): number {
		const density = Math.max(0, Math.min(1, this.settings.packingDensity));
		const densityFloor = 0.35 + density * 0.65;
		const priorityMultiplier =
			priority === "immediate" ? 0.65 : priority === "normal" ? 0.85 : 1;
		return Math.max(
			512,
			Math.floor(
				this.settings.maxTokensPerCall * densityFloor * priorityMultiplier,
			),
		);
	}

	private _priorityRank(
		priority: "background" | "normal" | "immediate",
	): number {
		return priority === "immediate" ? 0 : priority === "normal" ? 1 : 2;
	}

	private _buildPrompt(callPlan: { sections: ResolvedSection[] }): string {
		const sectionBlocks = callPlan.sections.map((resolvedSection, index) => {
			const fieldList = resolvedSection.section.schema
				.map((row) => {
					const prefix = sanitizeIdentifier(resolvedSection.section.id);
					const namespacedField = `${prefix}__${row.field}`;
					return `- ${namespacedField}: ${row.description}${row.required ? " (required)" : ""}`;
				})
				.join("\n");

			return [
				`SECTION ${index + 1}: ${resolvedSection.section.id}`,
				resolvedSection.section.preamble
					? `Instructions:\n${resolvedSection.section.preamble}`
					: "",
				`Context:\n${resolvedSection.resolvedContext || "[context unavailable]"}`,
				`Output fields for this section:\n${fieldList}`,
			]
				.filter(Boolean)
				.join("\n\n");
		});

		return [
			"You are answering multiple independent structured sections in one response.",
			"Read each section carefully.",
			"Use only the context provided for that section.",
			"Fill every requested field exactly once.",
			"Do not mix facts between sections.",
			"",
			sectionBlocks.join("\n\n====================\n\n"),
		].join("\n");
	}

	private _mergeExecOptions(
		options: Array<
			| {
					temperature?: number;
					maxTokens?: number;
					stopSequences?: string[];
			  }
			| undefined
		>,
	): {
		temperature?: number;
		maxTokens?: number;
		stopSequences?: string[];
	} {
		const temperatures = options
			.map((item) => item?.temperature)
			.filter((item): item is number => typeof item === "number");
		const maxTokens = options
			.map((item) => item?.maxTokens)
			.filter((item): item is number => typeof item === "number");
		const stopSequences = new Set<string>();

		for (const option of options) {
			for (const stop of option?.stopSequences ?? []) {
				stopSequences.add(stop);
			}
		}

		return {
			temperature:
				temperatures.length > 0 ? Math.min(...temperatures) : undefined,
			maxTokens: maxTokens.length > 0 ? Math.max(...maxTokens) : undefined,
			stopSequences:
				stopSequences.size > 0 ? Array.from(stopSequences) : undefined,
		};
	}
}
