/**
 * Tests for the skill eligibility providers: without AGENT_SKILLS_SERVICE they
 * cost nothing, a fully-healthy install collapses to a one-line status, mixed
 * installs render eligible/ineligible sections with reasons grouped into
 * binary/env/config remedies, and a failing service degrades to an explicit
 * unavailable state routed through reportError. Drives the real provider
 * modules against a scripted service double — every rendering and grouping
 * decision exercised here belongs to the module under test.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, State } from "../types";
import skillEligibilityDefault, {
	skillEligibilityCompactProvider,
	skillEligibilityProvider,
} from "./skill-eligibility";

type SkillFixture = {
	slug: string;
	name: string;
	description: string;
	source: string;
	sourceDir: string;
};

type ReasonFixture = {
	type: "bin" | "env" | "config";
	missing: string;
	message: string;
	suggestion?: string;
};

type EligibilityFixture = {
	slug: string;
	eligible: boolean;
	reasons: ReasonFixture[];
	checkedAt: number;
};

type IneligibleEntryFixture = {
	skill: SkillFixture;
	eligibility: EligibilityFixture;
};

type ServiceDouble = {
	getEligibleSkills: () => Promise<SkillFixture[]>;
	getIneligibleSkills: () => Promise<IneligibleEntryFixture[]>;
};

const message = {} as Memory;
const state = {} as State;

function makeSkill(slug: string, name: string): SkillFixture {
	return {
		slug,
		name,
		description: `${name} capability`,
		source: "bundled",
		sourceDir: `/skills/${slug}`,
	};
}

function makeReason(
	type: ReasonFixture["type"],
	missing: string,
	suggestion?: string,
): ReasonFixture {
	return {
		type,
		missing,
		message: `${missing} is required`,
		...(suggestion ? { suggestion } : {}),
	};
}

function makeEntry(
	slug: string,
	reasons: ReasonFixture[],
): IneligibleEntryFixture {
	const name = slug.charAt(0).toUpperCase() + slug.slice(1);
	return {
		skill: makeSkill(slug, name),
		eligibility: { slug, eligible: false, reasons, checkedAt: 0 },
	};
}

function harness(service: ServiceDouble | null) {
	const reported: Array<{ scope: string; error: unknown }> = [];
	const runtime = {
		getService: () => service,
		reportError: (scope: string, error: unknown) => {
			reported.push({ scope, error });
		},
	} as unknown as IAgentRuntime;
	return { runtime, reported };
}

function serviceDouble(
	eligible: SkillFixture[],
	ineligible: IneligibleEntryFixture[],
): ServiceDouble {
	return {
		getEligibleSkills: () => Promise.resolve(eligible),
		getIneligibleSkills: () => Promise.resolve(ineligible),
	};
}

describe("skillEligibilityProvider", () => {
	it("returns an empty result and reports nothing when the skills service is absent", async () => {
		const { runtime, reported } = harness(null);
		const result = await skillEligibilityProvider.get(runtime, message, state);
		expect(result.text).toBe("");
		expect(result.values).toEqual({});
		expect(result.data).toEqual({});
		expect(reported).toEqual([]);
	});

	it("collapses an all-eligible install to the ready summary", async () => {
		const eligible = [makeSkill("alpha", "Alpha"), makeSkill("beta", "Beta")];
		const { runtime, reported } = harness(serviceDouble(eligible, []));
		const result = await skillEligibilityProvider.get(runtime, message, state);
		expect(result.text).toBe(
			"**Skill Status:** All 2 installed skills are ready to use.",
		);
		expect(result.values).toEqual({
			eligibleCount: 2,
			ineligibleCount: 0,
		});
		expect(result.data).toEqual({
			eligible: ["alpha", "beta"],
			ineligible: [],
		});
		expect(reported).toEqual([]);
	});

	it("reports zero installed skills with zero counts on both sides", async () => {
		const { runtime } = harness(serviceDouble([], []));
		const result = await skillEligibilityProvider.get(runtime, message, state);
		expect(result.text).toBe(
			"**Skill Status:** All 0 installed skills are ready to use.",
		);
		expect(result.values).toEqual({ eligibleCount: 0, ineligibleCount: 0 });
		expect(result.data).toEqual({ eligible: [], ineligible: [] });
	});

	it("renders eligible and ineligible sections with grouped reasons and remedies", async () => {
		const eligible = [makeSkill("alpha", "Alpha"), makeSkill("beta", "Beta")];
		const gamma = makeEntry("gamma", [
			makeReason("bin", "ffmpeg", "brew install ffmpeg"),
			makeReason("bin", "yt-dlp"),
			makeReason("env", "GAMMA_TOKEN"),
		]);
		const delta = makeEntry("delta", [
			makeReason("env", "DELTA_TOKEN"),
			makeReason("config", "delta.apiKey"),
		]);
		const { runtime, reported } = harness(
			serviceDouble(eligible, [gamma, delta]),
		);

		const result = await skillEligibilityProvider.get(runtime, message, state);
		const text = result.text ?? "";

		expect(text).toContain("## Skill Eligibility");
		expect(text).toContain("### Ready to Use (2)");
		expect(text).toContain("- **Alpha** (alpha)");
		expect(text).toContain("- **Beta** (beta)");
		expect(text).toContain("### Missing Dependencies (2)");
		expect(text).toContain("#### Gamma (gamma)");
		expect(text).toContain("- Missing binaries: ffmpeg, yt-dlp");
		expect(text).toContain("  - brew install ffmpeg");
		expect(text).toContain("- Missing env vars: GAMMA_TOKEN");
		expect(text).toContain("#### Delta (delta)");
		expect(text).toContain("- Missing env vars: DELTA_TOKEN");
		expect(text).toContain("- Missing config: delta.apiKey");
		expect(text).toContain("### To enable more skills:");
		expect(text).toContain("- Install: ffmpeg, yt-dlp");
		expect(text).toContain("- Set env: GAMMA_TOKEN, DELTA_TOKEN");

		expect(result.values).toEqual({
			eligibleCount: 2,
			ineligibleCount: 2,
			missingBinaries: ["ffmpeg", "yt-dlp"],
			missingEnvVars: ["GAMMA_TOKEN", "DELTA_TOKEN"],
		});
		expect(result.data?.truncated).toBe(false);
		expect(result.data?.eligible).toEqual(["alpha", "beta"]);
		expect(result.data?.ineligible).toEqual([
			{ slug: "gamma", reasons: gamma.eligibility.reasons },
			{ slug: "delta", reasons: delta.eligibility.reasons },
		]);
		expect(reported).toEqual([]);
	});

	it("keeps the ineligible section when no skill is eligible", async () => {
		const entry = makeEntry("lonely", [makeReason("bin", "sox")]);
		const { runtime } = harness(serviceDouble([], [entry]));
		const result = await skillEligibilityProvider.get(runtime, message, state);
		const text = result.text ?? "";
		expect(text).not.toContain("Ready to Use");
		expect(text).toContain("### Missing Dependencies (1)");
		expect(text).toContain("#### Lonely (lonely)");
		expect(text).toContain("- Missing binaries: sox");
		expect(result.values?.eligibleCount).toBe(0);
		expect(result.values?.ineligibleCount).toBe(1);
	});

	it("renders a suggestion line only for binary reasons that carry one", async () => {
		const entry = makeEntry("tools", [
			makeReason("bin", "rg", "brew install ripgrep"),
			makeReason("bin", "fd"),
		]);
		const { runtime } = harness(serviceDouble([], [entry]));
		const result = await skillEligibilityProvider.get(runtime, message, state);
		const text = result.text ?? "";
		expect(text).toContain("- Missing binaries: rg, fd");
		const suggestionLines = (result.text ?? "")
			.split("\n")
			.filter((line) => line.startsWith("  - "));
		expect(suggestionLines).toEqual(["  - brew install ripgrep"]);
	});

	it("does not emit the remediation summary for config-only gaps", async () => {
		const entry = makeEntry("cfgonly", [
			makeReason("config", "cfgonly.endpoint"),
		]);
		const { runtime } = harness(
			serviceDouble([makeSkill("ok", "Ok")], [entry]),
		);
		const result = await skillEligibilityProvider.get(runtime, message, state);
		const text = result.text ?? "";
		expect(text).toContain("- Missing config: cfgonly.endpoint");
		expect(text).not.toContain("Missing binaries");
		expect(text).not.toContain("Missing env vars");
		expect(text).not.toContain("To enable more skills");
		expect(result.values?.missingBinaries).toEqual([]);
		expect(result.values?.missingEnvVars).toEqual([]);
	});

	it("leaves a zero-reason ineligible skill headed but unexplained", async () => {
		const entry = makeEntry("mystery", []);
		const { runtime } = harness(serviceDouble([], [entry]));
		const result = await skillEligibilityProvider.get(runtime, message, state);
		const text = result.text ?? "";
		expect(text).toContain("### Missing Dependencies (1)");
		expect(text).toContain("#### Mystery (mystery)");
		expect(text).not.toContain("Missing binaries");
		expect(text).not.toContain("Missing env vars");
		expect(text).not.toContain("Missing config");
		expect(text).not.toContain("To enable more skills");
		expect(result.values?.ineligibleCount).toBe(1);
	});

	it("dedupes repeated dependencies across skills preserving first-seen order", async () => {
		const first = makeEntry("one", [
			makeReason("bin", "ffmpeg"),
			makeReason("env", "SHARED_TOKEN"),
		]);
		const second = makeEntry("two", [
			makeReason("bin", "ffmpeg"),
			makeReason("bin", "node"),
			makeReason("env", "TWO_TOKEN"),
			makeReason("env", "SHARED_TOKEN"),
		]);
		const { runtime } = harness(serviceDouble([], [first, second]));
		const result = await skillEligibilityProvider.get(runtime, message, state);
		expect(result.values?.missingBinaries).toEqual(["ffmpeg", "node"]);
		expect(result.values?.missingEnvVars).toEqual([
			"SHARED_TOKEN",
			"TWO_TOKEN",
		]);
		const text = result.text ?? "";
		expect(text.match(/Install: ffmpeg/g)).toHaveLength(1);
		expect(text).toContain("- Install: ffmpeg, node");
		expect(text).toContain("- Set env: SHARED_TOKEN, TWO_TOKEN");
	});

	it("starts both service lookups before either settles", async () => {
		let releaseEligible: ((skills: SkillFixture[]) => void) | undefined;
		let releaseIneligible:
			| ((entries: IneligibleEntryFixture[]) => void)
			| undefined;
		let eligibleCalls = 0;
		let ineligibleCalls = 0;
		const eligibleGate = new Promise<SkillFixture[]>((resolve) => {
			releaseEligible = resolve;
		});
		const ineligibleGate = new Promise<IneligibleEntryFixture[]>((resolve) => {
			releaseIneligible = resolve;
		});
		const service: ServiceDouble = {
			getEligibleSkills: () => {
				eligibleCalls += 1;
				return eligibleGate;
			},
			getIneligibleSkills: () => {
				ineligibleCalls += 1;
				return ineligibleGate;
			},
		};
		const { runtime } = harness(service);

		const pending = skillEligibilityProvider.get(runtime, message, state);
		if (!releaseEligible || !releaseIneligible) {
			throw new Error("gates were not wired");
		}
		expect(eligibleCalls).toBe(1);
		expect(ineligibleCalls).toBe(1);

		releaseEligible([]);
		releaseIneligible([makeEntry("late", [makeReason("env", "LATE_TOKEN")])]);
		const result = await pending;
		expect(result.values?.ineligibleCount).toBe(1);
	});

	it("degrades to an explicit unavailable state when the service throws an Error", async () => {
		const failure = new Error("eligibility scan exploded");
		const service: ServiceDouble = {
			getEligibleSkills: () => Promise.resolve([]),
			getIneligibleSkills: () => Promise.reject(failure),
		};
		const { runtime, reported } = harness(service);
		const result = await skillEligibilityProvider.get(runtime, message, state);
		expect(result.text).toBe("Skill eligibility is unavailable.");
		expect(result.values).toEqual({ skillEligibilityAvailable: false });
		expect(result.data).toEqual({
			available: false,
			error: "eligibility scan exploded",
		});
		expect(reported).toHaveLength(1);
		expect(reported[0].scope).toBe("SkillEligibilityProvider.get");
		expect(reported[0].error).toBe(failure);
	});

	it("stringifies non-Error service failures into the unavailable payload", async () => {
		const service: ServiceDouble = {
			getEligibleSkills: () => Promise.reject("plain string failure"),
			getIneligibleSkills: () => Promise.resolve([]),
		};
		const { runtime, reported } = harness(service);
		const result = await skillEligibilityProvider.get(runtime, message, state);
		expect(result.text).toBe("Skill eligibility is unavailable.");
		expect(result.values).toEqual({ skillEligibilityAvailable: false });
		expect(result.data).toEqual({
			available: false,
			error: "plain string failure",
		});
		expect(reported).toHaveLength(1);
		expect(reported[0].error).toBe("plain string failure");
	});
});

describe("skillEligibilityCompactProvider", () => {
	it("returns an empty result without reporting when the service is absent", async () => {
		const { runtime, reported } = harness(null);
		const result = await skillEligibilityCompactProvider.get(
			runtime,
			message,
			state,
		);
		expect(result.text).toBe("");
		expect(result.values).toEqual({});
		expect(result.data).toEqual({});
		expect(reported).toEqual([]);
	});

	it("stays silent with an empty ineligible list when every skill is ready", async () => {
		const eligible = [makeSkill("alpha", "Alpha")];
		const { runtime } = harness(serviceDouble(eligible, []));
		const result = await skillEligibilityCompactProvider.get(
			runtime,
			message,
			state,
		);
		expect(result.text).toBe("");
		expect(result.values).toEqual({});
		expect(result.data).toEqual({ ineligible: [] });
	});

	it("lists a single non-binary gap without a missing-dependency suffix", async () => {
		const entry = makeEntry("solo", [makeReason("env", "SOLO_TOKEN")]);
		const { runtime } = harness(serviceDouble([], [entry]));
		const result = await skillEligibilityCompactProvider.get(
			runtime,
			message,
			state,
		);
		expect(result.text).toBe("⚠️ Skills unavailable: solo");
		expect(result.values).toEqual({ ineligibleCount: 1 });
		expect(result.data).toEqual({
			ineligible: ["solo"],
			missingBins: [],
			omittedCount: 0,
		});
	});

	it("lists every ineligible slug in service order with zero omissions", async () => {
		const entries = [
			makeEntry("gamma", [makeReason("bin", "ffmpeg")]),
			makeEntry("alpha", [makeReason("env", "ALPHA_TOKEN")]),
			makeEntry("beta", []),
		];
		const { runtime } = harness(serviceDouble([], entries));
		const result = await skillEligibilityCompactProvider.get(
			runtime,
			message,
			state,
		);
		expect(result.text).toContain("gamma, alpha, beta");
		expect(result.values).toEqual({ ineligibleCount: 3 });
		expect(result.data?.ineligible).toEqual(["gamma", "alpha", "beta"]);
		expect(result.data?.omittedCount).toBe(0);
	});

	it("aggregates duplicated binary requirements once, in first-seen order", async () => {
		const first = makeEntry("one", [
			makeReason("bin", "ffmpeg"),
			makeReason("bin", "yt-dlp"),
			makeReason("bin", "ffmpeg"),
		]);
		const second = makeEntry("two", [
			makeReason("bin", "node"),
			makeReason("bin", "yt-dlp"),
		]);
		const { runtime } = harness(serviceDouble([], [first, second]));
		const result = await skillEligibilityCompactProvider.get(
			runtime,
			message,
			state,
		);
		expect(result.text).toBe(
			"⚠️ Skills unavailable: one, two (missing: ffmpeg, yt-dlp, node)",
		);
		expect(result.data?.missingBins).toEqual(["ffmpeg", "yt-dlp", "node"]);
	});

	it("surfaces only binaries in the compact suffix even when env and config also miss", async () => {
		const entry = makeEntry("mixed", [
			makeReason("env", "MIXED_TOKEN"),
			makeReason("bin", "jq"),
			makeReason("config", "mixed.key"),
		]);
		const { runtime } = harness(serviceDouble([], [entry]));
		const result = await skillEligibilityCompactProvider.get(
			runtime,
			message,
			state,
		);
		expect(result.text).toBe("⚠️ Skills unavailable: mixed (missing: jq)");
		expect(result.data?.missingBins).toEqual(["jq"]);
		expect(result.text).not.toContain("MIXED_TOKEN");
		expect(result.text).not.toContain("mixed.key");
	});

	it("degrades to the explicit unavailable state when the service fails with an Error", async () => {
		const failure = new Error("compact scan failed");
		const service: ServiceDouble = {
			getEligibleSkills: () => Promise.resolve([]),
			getIneligibleSkills: () => Promise.reject(failure),
		};
		const { runtime, reported } = harness(service);
		const result = await skillEligibilityCompactProvider.get(
			runtime,
			message,
			state,
		);
		expect(result.text).toBe("Skill eligibility is unavailable.");
		expect(result.values).toEqual({ skillEligibilityAvailable: false });
		expect(result.data).toEqual({
			available: false,
			error: "compact scan failed",
		});
		expect(reported).toHaveLength(1);
		expect(reported[0].scope).toBe("SkillEligibilityCompactProvider.get");
		expect(reported[0].error).toBe(failure);
	});

	it("stringifies non-Error compact failures", async () => {
		const service: ServiceDouble = {
			getEligibleSkills: () => Promise.resolve([]),
			getIneligibleSkills: () => Promise.reject({ code: 7 }),
		};
		const { runtime, reported } = harness(service);
		const result = await skillEligibilityCompactProvider.get(
			runtime,
			message,
			state,
		);
		expect(result.data).toEqual({
			available: false,
			error: "[object Object]",
		});
		expect(reported).toHaveLength(1);
		expect(reported[0].error).toEqual({ code: 7 });
	});
});

describe("skill eligibility provider metadata and exports", () => {
	it("exposes invocation-controlling metadata on both providers", () => {
		for (const provider of [
			skillEligibilityProvider,
			skillEligibilityCompactProvider,
		]) {
			expect(provider.position).toBe(-5);
			expect(provider.dynamic).toBe(true);
			expect(provider.contexts).toEqual(["general", "agent_internal"]);
			expect(provider.contextGate).toEqual({
				anyOf: ["general", "agent_internal"],
			});
			expect(provider.cacheStable).toBe(false);
			expect(provider.cacheScope).toBe("turn");
			expect(provider.roleGate).toEqual({ minRole: "USER" });
		}
		expect(skillEligibilityProvider.name).toBe("skill_eligibility");
		expect(skillEligibilityProvider.description).toBe(
			"Shows which skills are eligible and which have missing dependencies",
		);
		expect(skillEligibilityCompactProvider.name).toBe(
			"skill_eligibility_compact",
		);
		expect(skillEligibilityCompactProvider.description).toBe(
			"Compact view of ineligible skills only",
		);
	});

	it("aliases the default export to the primary provider", () => {
		expect(skillEligibilityDefault).toBe(skillEligibilityProvider);
	});
});
