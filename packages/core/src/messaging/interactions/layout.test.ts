/**
 * Unit tests for interaction blocks neutral layout projection and plain-text fallback rendering.
 */

import { describe, expect, it } from "vitest";
import type { InteractionBlock } from "../../types/interactions.js";
import {
	buildInteractionUrlResolver,
	FORM_FREE_TEXT_INVITE,
	renderContentInteractionsAsPlainText,
	renderInteractionsAsPlainText,
	toNeutralLayout,
	toPlainTextFallback,
} from "./layout.js";

describe("messaging interactions layout", () => {
	it("projects choice blocks to neutral button layout with callback data", () => {
		const block: InteractionBlock = {
			kind: "choice",
			id: "choice-1",
			scope: "test",
			prompt: "Choose your favorite fruit",
			options: [
				{ label: "Apple", value: "apple" },
				{ label: "Banana", value: "banana" },
			],
			allowCustom: false,
		};

		const layout = toNeutralLayout(block, { maxButtonsPerRow: 2 });
		expect(layout.text).toBe("Choose your favorite fruit");
		expect(layout.rows).toHaveLength(1);
		expect(layout.rows[0].buttons).toHaveLength(2);
		expect(layout.rows[0].buttons?.[0].label).toBe("Apple");
		expect(layout.rows[0].buttons?.[0].callbackData).toBe("ia1:apple");
		expect(layout.needsFallback).toBe(false);
	});

	it("handles choice blocks with allowCustom requiring fallback", () => {
		const block: InteractionBlock = {
			kind: "choice",
			id: "choice-2",
			scope: "test",
			prompt: "Select or write your own",
			options: [{ label: "Opt1", value: "opt1" }],
			allowCustom: true,
		};

		const layout = toNeutralLayout(block);
		expect(layout.needsFallback).toBe(true);
	});

	it("renders secret blocks with url or requires fallback", () => {
		const blockWithUrl: InteractionBlock = {
			kind: "secret",
			id: "secret-1",
			reason: "API key needed",
			url: "https://example.com/oauth",
			secretKind: "oauth",
			provider: "github",
		};

		const layout = toNeutralLayout(blockWithUrl);
		expect(layout.text).toBe("API key needed");
		expect(layout.rows[0].buttons?.[0].label).toBe("Connect github");
		expect(layout.rows[0].buttons?.[0].url).toBe("https://example.com/oauth");
		expect(layout.needsFallback).toBe(false);

		const blockWithoutUrl: InteractionBlock = {
			kind: "secret",
			id: "secret-2",
			reason: "Secret key",
			secretKind: "secret",
		};
		const noUrlLayout = toNeutralLayout(blockWithoutUrl);
		expect(noUrlLayout.needsFallback).toBe(true);
	});

	it("formats plain text fallback for choice, form, and followups", () => {
		const choiceBlock: InteractionBlock = {
			kind: "choice",
			id: "choice-3",
			scope: "test",
			prompt: "Pick one",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
		};
		const text = toPlainTextFallback(choiceBlock);
		expect(text).toContain("Pick one");
		expect(text).toContain("1. Red");
		expect(text).toContain("2. Blue");
		expect(text).toContain("Reply with a number.");

		const formBlock: InteractionBlock = {
			kind: "form",
			id: "form-1",
			title: "Survey",
			description: "Tell us your thoughts",
			fields: [],
		};
		const formText = toPlainTextFallback(formBlock);
		expect(formText).toContain("Survey");
		expect(formText).toContain(FORM_FREE_TEXT_INVITE);
	});

	it("renders interaction-bearing text and content as plain text", () => {
		const plainResult = renderInteractionsAsPlainText("Simple raw text");
		expect(plainResult.hadBlocks).toBe(false);
		expect(plainResult.text).toBe("Simple raw text");

		const { text, hadBlocks } = renderContentInteractionsAsPlainText({
			text: "Please answer the prompt below:",
			interactions: [
				{
					kind: "choice",
					id: "choice-4",
					scope: "test",
					prompt: "Confirm action",
					options: [{ label: "Yes", value: "yes" }],
				},
			],
		});

		expect(hadBlocks).toBe(true);
		expect(text).toContain("Please answer the prompt below:");
		expect(text).toContain("Confirm action");
		expect(text).toContain("1. Yes");
	});

	it("builds interaction URL resolvers for tasks and navigate chips", () => {
		const resolver = buildInteractionUrlResolver("https://eliza.app/");
		expect(resolver.resolveUrl).toBeDefined();
		expect(resolver.resolveNavigateUrl).toBeDefined();

		const taskBlock: InteractionBlock = {
			kind: "task",
			title: "Clean Database",
			threadId: "task-99",
		};
		expect(resolver.resolveUrl?.(taskBlock)).toBe(
			"https://eliza.app/orchestrator?taskId=task-99",
		);

		expect(resolver.resolveNavigateUrl?.("/dashboard")).toBe(
			"https://eliza.app/dashboard",
		);
		expect(resolver.resolveNavigateUrl?.("settings")).toBe(
			"https://eliza.app/?view=settings",
		);
	});
});

describe("messaging interactions layout branch coverage", () => {
	describe("toNeutralLayout", () => {
		it("wraps choice options into rows of three by default and preserves order", () => {
			const labels = ["A", "B", "C", "D", "E", "F", "G"];
			const block: InteractionBlock = {
				kind: "choice",
				id: "c-wrap",
				scope: "wrap",
				prompt: "Wrap",
				options: labels.map((label) => ({
					label,
					value: label.toLowerCase(),
				})),
			};
			const layout = toNeutralLayout(block);
			expect(layout.rows.map((row) => row.buttons?.length)).toEqual([3, 3, 1]);
			expect(
				layout.rows
					.flatMap((row) => row.buttons ?? [])
					.map((button) => button.label),
			).toEqual(labels);
			expect(layout.needsFallback).toBe(false);
		});

		it("wraps an exact multiple of buttons per row without an empty trailing row", () => {
			const block: InteractionBlock = {
				kind: "choice",
				id: "c-even",
				scope: "even",
				options: [
					{ label: "1", value: "one" },
					{ label: "2", value: "two" },
					{ label: "3", value: "three" },
					{ label: "4", value: "four" },
				],
			};
			const layout = toNeutralLayout(block, { maxButtonsPerRow: 2 });
			expect(layout.rows.map((row) => row.buttons?.length)).toEqual([2, 2]);
		});

		it("keeps a callback payload that exactly fills the default byte budget", () => {
			const value = "y".repeat(60);
			const block: InteractionBlock = {
				kind: "choice",
				id: "c-boundary",
				scope: "boundary",
				options: [{ label: "Long", value }],
			};
			const layout = toNeutralLayout(block);
			expect(layout.needsFallback).toBe(false);
			expect(layout.rows[0]?.buttons?.[0]?.callbackData).toBe(`ia1:${value}`);
		});

		it("forces fallback when an option exceeds the native callback budget", () => {
			const block: InteractionBlock = {
				kind: "choice",
				id: "c-big",
				scope: "big",
				options: [{ label: "Too long", value: "z".repeat(100) }],
			};
			const layout = toNeutralLayout(block);
			expect(layout.rows).toEqual([]);
			expect(layout.needsFallback).toBe(true);
		});

		it("honors a connector-specific callback budget", () => {
			const block: InteractionBlock = {
				kind: "choice",
				id: "c-budget",
				scope: "budget",
				options: [
					{ label: "Fits Discord", value: "d".repeat(90) },
					{ label: "Fits nowhere", value: "w".repeat(120) },
				],
			};
			const layout = toNeutralLayout(block, { maxCallbackBytes: 100 });
			expect(layout.rows[0]?.buttons?.map((b) => b.label)).toEqual([
				"Fits Discord",
			]);
			expect(layout.needsFallback).toBe(true);
		});

		it("projects empty choice options to no rows without forcing fallback", () => {
			const block: InteractionBlock = {
				kind: "choice",
				id: "c-empty",
				scope: "empty",
				prompt: "Nothing to pick",
				options: [],
			};
			const layout = toNeutralLayout(block);
			expect(layout.text).toBe("Nothing to pick");
			expect(layout.rows).toEqual([]);
			expect(layout.needsFallback).toBe(false);
		});

		it("throws RangeError for invalid maxButtonsPerRow values", () => {
			const block: InteractionBlock = {
				kind: "choice",
				id: "c-invalid",
				scope: "invalid",
				options: [{ label: "Only", value: "only" }],
			};
			for (const invalid of [
				0,
				-2,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
			]) {
				expect(() =>
					toNeutralLayout(block, { maxButtonsPerRow: invalid }),
				).toThrow(RangeError);
			}
		});

		it("renders reply and prompt followups as secondary callback buttons", () => {
			const block: InteractionBlock = {
				kind: "followups",
				id: "f-reply",
				options: [
					{ kind: "reply", payload: "show cats", label: "Show cats" },
					{ kind: "prompt", payload: "why?", label: "Ask why" },
				],
			};
			const layout = toNeutralLayout(block);
			expect(layout.rows).toHaveLength(1);
			expect(layout.rows[0]?.buttons).toEqual([
				{
					label: "Show cats",
					callbackData: "ia1:show cats",
					style: "secondary",
				},
				{ label: "Ask why", callbackData: "ia1:why?", style: "secondary" },
			]);
			expect(layout.needsFallback).toBeUndefined();
		});

		it("renders resolved navigate followups as link-out buttons", () => {
			const block: InteractionBlock = {
				kind: "followups",
				id: "f-nav",
				options: [
					{ kind: "navigate", payload: "grid", label: "Open grid" },
					{ kind: "reply", payload: "hi", label: "Say hi" },
				],
			};
			const layout = toNeutralLayout(block, {
				resolveNavigateUrl: (payload) =>
					payload === "grid" ? "https://app.example/?view=grid" : undefined,
			});
			expect(layout.rows[0]?.buttons?.[0]).toEqual({
				label: "Open grid",
				url: "https://app.example/?view=grid",
				style: "secondary",
			});
			expect(layout.rows[0]?.buttons?.[1]?.callbackData).toBe("ia1:hi");
		});

		it("falls back to a reply callback when navigation cannot be resolved", () => {
			const block: InteractionBlock = {
				kind: "followups",
				id: "f-navmiss",
				options: [
					{ kind: "navigate", payload: "missing-view", label: "Missing" },
				],
			};
			const layout = toNeutralLayout(block, {
				resolveNavigateUrl: () => undefined,
			});
			expect(layout.rows[0]?.buttons?.[0]).toEqual({
				label: "Missing",
				callbackData: "ia1:missing-view",
				style: "secondary",
			});
		});

		it("silently drops followup payloads beyond the callback budget", () => {
			const block: InteractionBlock = {
				kind: "followups",
				id: "f-big",
				options: [
					{ kind: "reply", payload: "ok", label: "Ok" },
					{ kind: "reply", payload: "p".repeat(70), label: "Too big" },
				],
			};
			const layout = toNeutralLayout(block);
			expect(layout.rows[0]?.buttons?.map((b) => b.label)).toEqual(["Ok"]);
			expect(layout.needsFallback).toBeUndefined();
		});

		it("renders a resolvable task as a titled primary link-out", () => {
			const block: InteractionBlock = {
				kind: "task",
				threadId: "task-1",
				title: "Water Tracker Page",
			};
			const layout = toNeutralLayout(block, {
				resolveUrl: () => "https://app.example/orchestrator?taskId=task-1",
			});
			expect(layout.text).toBe("Water Tracker Page");
			expect(layout.rows).toEqual([
				{
					buttons: [
						{
							label: "Open task",
							url: "https://app.example/orchestrator?taskId=task-1",
							style: "primary",
						},
					],
				},
			]);
			expect(layout.needsFallback).toBe(false);
		});

		it("renders an unresolvable task as dashboard-only with no dangling title", () => {
			const block: InteractionBlock = {
				kind: "task",
				threadId: "task-2",
				title: "Daily Quote Page",
			};
			const layout = toNeutralLayout(block);
			expect(layout.text).toBe("");
			expect(layout.rows).toEqual([]);
			expect(layout.needsFallback).toBe(false);
		});

		it("links a form out with the configured submit label", () => {
			const block: InteractionBlock = {
				kind: "form",
				id: "form-link",
				title: "Survey",
				description: "Tell us your thoughts",
				submitLabel: "Start survey",
				fields: [],
			};
			const layout = toNeutralLayout(block, {
				resolveUrl: () => "https://forms.example/s/1",
			});
			expect(layout.text).toBe("Survey");
			expect(layout.rows).toEqual([
				{
					buttons: [
						{
							label: "Start survey",
							url: "https://forms.example/s/1",
							style: "primary",
						},
					],
				},
			]);
			expect(layout.needsFallback).toBeUndefined();
		});

		it("uses the default Open form label when no submit label is set", () => {
			const block: InteractionBlock = {
				kind: "form",
				id: "form-default-label",
				fields: [],
			};
			const layout = toNeutralLayout(block, {
				resolveUrl: () => "https://forms.example/s/2",
			});
			expect(layout.text).toBeUndefined();
			expect(layout.rows[0]?.buttons?.[0]).toEqual({
				label: "Open form",
				url: "https://forms.example/s/2",
				style: "primary",
			});
		});

		it("invites a free-text reply for a form without a hosted page", () => {
			const full: InteractionBlock = {
				kind: "form",
				id: "form-full",
				title: "Survey",
				description: "Tell us your thoughts",
				fields: [],
			};
			expect(toNeutralLayout(full)).toEqual({
				text: `Survey\n\n${FORM_FREE_TEXT_INVITE}`,
				rows: [],
				needsFallback: true,
			});

			const descriptionOnly: InteractionBlock = {
				kind: "form",
				id: "form-desc",
				description: "Describe me",
				fields: [],
			};
			expect(toNeutralLayout(descriptionOnly).text).toBe(
				`Describe me\n\n${FORM_FREE_TEXT_INVITE}`,
			);

			const blank: InteractionBlock = {
				kind: "form",
				id: "form-blank",
				title: "   ",
				fields: [],
			};
			expect(toNeutralLayout(blank).text).toBe(FORM_FREE_TEXT_INVITE);

			const bare: InteractionBlock = {
				kind: "form",
				id: "form-bare",
				fields: [],
			};
			const bareLayout = toNeutralLayout(bare);
			expect(bareLayout.text).toBe(FORM_FREE_TEXT_INVITE);
			expect(bareLayout.rows).toEqual([]);
			expect(bareLayout.needsFallback).toBe(true);
		});

		it("prefers the resolver URL over a secret block's own entry URL", () => {
			const block: InteractionBlock = {
				kind: "secret",
				id: "secret-precedence",
				secretKind: "oauth",
				provider: "github",
				reason: "Connect GitHub",
				url: "https://block.example/oauth",
			};
			const layout = toNeutralLayout(block, {
				resolveUrl: () => "https://resolver.example/oauth/github",
			});
			expect(layout.rows[0]?.buttons?.[0]?.url).toBe(
				"https://resolver.example/oauth/github",
			);
			expect(layout.needsFallback).toBe(false);
		});

		it("labels secret buttons per secret kind and provider", () => {
			const oauthWithoutProvider = toNeutralLayout({
				kind: "secret",
				id: "secret-oauth-anon",
				secretKind: "oauth",
				url: "https://id.example/consent",
			});
			expect(oauthWithoutProvider.rows[0]?.buttons?.[0]?.label).toBe(
				"Connect account",
			);

			const labeledSecret = toNeutralLayout({
				kind: "secret",
				id: "secret-labeled",
				secretKind: "secret",
				submitLabel: "Add OpenAI key",
				url: "https://keys.example",
			});
			expect(labeledSecret.rows[0]?.buttons?.[0]?.label).toBe("Add OpenAI key");

			const defaultSecret = toNeutralLayout({
				kind: "secret",
				id: "secret-default-label",
				secretKind: "secret",
				url: "https://vault.example",
			});
			expect(defaultSecret.rows[0]?.buttons?.[0]?.label).toBe(
				"Provide securely",
			);
		});
	});

	describe("toPlainTextFallback", () => {
		it("offers the custom-answer invite only when custom answers are allowed", () => {
			const custom: InteractionBlock = {
				kind: "choice",
				id: "pt-custom",
				scope: "custom",
				prompt: "Favorite fruit?",
				options: [{ label: "Apple", value: "apple" }],
				allowCustom: true,
			};
			expect(toPlainTextFallback(custom)).toBe(
				"Favorite fruit?\n1. Apple\nReply with a number or your own answer.",
			);
		});

		it("drops a blank choice prompt and keeps the numbered list", () => {
			const blankPrompt: InteractionBlock = {
				kind: "choice",
				id: "pt-blank-prompt",
				scope: "blank-prompt",
				prompt: "   ",
				options: [{ label: "Red", value: "red" }],
			};
			expect(toPlainTextFallback(blankPrompt)).toBe(
				"1. Red\nReply with a number.",
			);
		});

		it("renders followup suggestions with resolved navigation links", () => {
			const block: InteractionBlock = {
				kind: "followups",
				id: "pt-followups",
				options: [
					{ kind: "reply", payload: "say-hi", label: "Say hi" },
					{ kind: "navigate", payload: "grid", label: "Open grid" },
					{ kind: "reply", payload: "gone", label: "   " },
				],
			};
			expect(
				toPlainTextFallback(block, {
					resolveNavigateUrl: (payload) =>
						payload === "grid" ? "https://app.example/?view=grid" : undefined,
				}),
			).toBe(
				"Suggestions: Say hi / Open grid (https://app.example/?view=grid)",
			);
		});

		it("returns undefined for followups whose labels are all blank", () => {
			const block: InteractionBlock = {
				kind: "followups",
				id: "pt-followups-blank",
				options: [{ kind: "reply", payload: "x", label: "  " }],
			};
			expect(toPlainTextFallback(block)).toBeUndefined();
		});

		it("joins the task title and URL only when the task resolves", () => {
			const block: InteractionBlock = {
				kind: "task",
				threadId: "task-3",
				title: "Clean Database",
			};
			expect(
				toPlainTextFallback(block, {
					resolveUrl: () => "https://app.example/orchestrator?taskId=task-3",
				}),
			).toBe("Clean Database\nhttps://app.example/orchestrator?taskId=task-3");
			expect(toPlainTextFallback(block)).toBeUndefined();
		});

		it("keeps whichever form prose exists and always appends the invite", () => {
			expect(
				toPlainTextFallback({
					kind: "form",
					id: "pt-form-title",
					title: "Survey",
					fields: [],
				}),
			).toBe(`Survey\n\n${FORM_FREE_TEXT_INVITE}`);
			expect(
				toPlainTextFallback({
					kind: "form",
					id: "pt-form-description",
					description: "Thoughts?",
					fields: [],
				}),
			).toBe(`Thoughts?\n\n${FORM_FREE_TEXT_INVITE}`);
			expect(
				toPlainTextFallback({
					kind: "form",
					id: "pt-form-blank",
					title: "  ",
					description: " \t ",
					fields: [],
				}),
			).toBe(FORM_FREE_TEXT_INVITE);
		});

		it("falls back to the block URL for secrets and explains a missing link", () => {
			expect(
				toPlainTextFallback(
					{
						kind: "secret",
						id: "pt-secret-resolver",
						secretKind: "oauth",
						reason: "Connect GitHub",
						url: "https://block.example/gh",
					},
					{ resolveUrl: () => "https://resolver.example/gh" },
				),
			).toBe("Connect GitHub\nhttps://resolver.example/gh");

			expect(
				toPlainTextFallback({
					kind: "secret",
					id: "pt-secret-url",
					secretKind: "secret",
					reason: "API key",
					url: "https://keys.example",
				}),
			).toBe("API key\nhttps://keys.example");

			expect(
				toPlainTextFallback({
					kind: "secret",
					id: "pt-secret-no-reason",
					secretKind: "secret",
					url: "https://keys.example",
				}),
			).toBe("https://keys.example");

			expect(
				toPlainTextFallback({
					kind: "secret",
					id: "pt-secret-no-url",
					secretKind: "secret",
					reason: "Vault token",
				}),
			).toBe("Vault token\nA secure link for this is not available here yet.");

			expect(
				toPlainTextFallback({
					kind: "secret",
					id: "pt-secret-bare",
					secretKind: "secret",
				}),
			).toBe("A secure link for this is not available here yet.");
		});
	});

	describe("renderInteractionsAsPlainText", () => {
		it("treats nullish input as empty plain text", () => {
			expect(renderInteractionsAsPlainText(undefined)).toEqual({
				text: "",
				hadBlocks: false,
			});
			expect(renderInteractionsAsPlainText(null)).toEqual({
				text: "",
				hadBlocks: false,
			});
		});

		it("parses marker blocks and appends fallbacks in document order", () => {
			const marked = [
				"Pick a starting point:",
				"[TASK:9b1deb4d3b7d4bad9bdd2b0d7b3dcb6d]Water Tracker Page[/TASK]",
				"[FOLLOWUPS]",
				"reply:say-hi=Say hi",
				"navigate:/dashboard=Open dashboard",
				"[/FOLLOWUPS]",
			].join("\n");
			const { text, hadBlocks } = renderInteractionsAsPlainText(marked, {
				resolveUrl: () => "https://app.example/orchestrator?taskId=t",
				resolveNavigateUrl: () => "https://app.example/dashboard",
			});
			expect(hadBlocks).toBe(true);
			expect(text).toContain("Pick a starting point:");
			expect(text).toContain(
				"Water Tracker Page\nhttps://app.example/orchestrator?taskId=t",
			);
			expect(text).toContain(
				"Suggestions: Say hi / Open dashboard (https://app.example/dashboard)",
			);
			expect(text.indexOf("Water Tracker Page")).toBeLessThan(
				text.indexOf("Suggestions:"),
			);
			expect(text).not.toContain("[TASK:");
			expect(text).not.toContain("[/FOLLOWUPS]");
			expect(text).not.toContain("reply:say-hi");
		});

		it("omits fallback sections for blocks that cannot produce one", () => {
			const marked =
				"Working on it.\n[TASK:abcdef123456]Daily Quote Page[/TASK]";
			const { text, hadBlocks } = renderInteractionsAsPlainText(marked);
			expect(hadBlocks).toBe(true);
			expect(text).toBe("Working on it.");
		});

		it("strips an unclaimed terminal marker fragment instead of restoring it", () => {
			const broken = "Hello\n[CHOICE:test]\napple=Apple";
			const { text, hadBlocks } = renderInteractionsAsPlainText(broken);
			expect(hadBlocks).toBe(false);
			expect(text).toBe("Hello");
		});

		it("strips dashboard-only markers from connector-bound text", () => {
			const { text, hadBlocks } = renderInteractionsAsPlainText(
				"Before\n[CONFIG:google_calendars]\nafter",
			);
			expect(hadBlocks).toBe(false);
			expect(text).not.toContain("[CONFIG:");
			expect(text).toContain("Before");
			expect(text).toContain("after");
		});
	});

	describe("renderContentInteractionsAsPlainText", () => {
		const oauthSecret: InteractionBlock = {
			kind: "secret",
			id: "content-secret",
			secretKind: "oauth",
			provider: "github",
			reason: "Connect GitHub to continue",
			url: "https://oauth.example/gh",
		};

		it("delegates to the text renderer for nullish and marker-free content", () => {
			expect(renderContentInteractionsAsPlainText(undefined)).toEqual({
				text: "",
				hadBlocks: false,
			});
			expect(renderContentInteractionsAsPlainText(null)).toEqual({
				text: "",
				hadBlocks: false,
			});
			expect(
				renderContentInteractionsAsPlainText({ text: "Just words" }),
			).toEqual({ text: "Just words", hadBlocks: false });
		});

		it("lets typed interactions win over conflicting text markers", () => {
			const { text, hadBlocks } = renderContentInteractionsAsPlainText({
				text: "Answer below:\n[CHOICE:mood]\nhappy=Happy\n[/CHOICE]",
				interactions: [oauthSecret],
			});
			expect(hadBlocks).toBe(true);
			expect(text).toContain("Answer below:");
			expect(text).toContain(
				"Connect GitHub to continue\nhttps://oauth.example/gh",
			);
			expect(text).not.toContain("Happy");
			expect(text).not.toContain("1.");
		});

		it("renders out-of-band interactions that have no text marker", () => {
			const { text, hadBlocks } = renderContentInteractionsAsPlainText({
				text: "Here you go.",
				interactions: [oauthSecret],
			});
			expect(hadBlocks).toBe(true);
			expect(text).toBe(
				"Here you go.\n\nConnect GitHub to continue\nhttps://oauth.example/gh",
			);
		});

		it("renders typed interactions even when the text is blank or missing", () => {
			const choice: InteractionBlock = {
				kind: "choice",
				id: "content-choice",
				scope: "confirm",
				prompt: "Ship it?",
				options: [{ label: "Yes", value: "yes" }],
			};
			expect(
				renderContentInteractionsAsPlainText({ interactions: [choice] }).text,
			).toBe("Ship it?\n1. Yes\nReply with a number.");

			const { text, hadBlocks } = renderContentInteractionsAsPlainText({
				text: "   ",
				interactions: [choice],
			});
			expect(hadBlocks).toBe(true);
			expect(text).toBe("Ship it?\n1. Yes\nReply with a number.");
		});
	});

	describe("buildInteractionUrlResolver", () => {
		it("returns no resolvers when no app base URL is configured", () => {
			expect(buildInteractionUrlResolver(undefined)).toEqual({});
			expect(buildInteractionUrlResolver(null)).toEqual({});
			expect(buildInteractionUrlResolver("")).toEqual({});
		});

		it("normalizes trailing slashes on the base URL", () => {
			const resolver = buildInteractionUrlResolver("https://app.example///");
			expect(
				resolver.resolveUrl?.({
					kind: "task",
					threadId: "abc12345",
					title: "T",
				}),
			).toBe("https://app.example/orchestrator?taskId=abc12345");
			expect(resolver.resolveNavigateUrl?.("home")).toBe(
				"https://app.example/?view=home",
			);
		});

		it("percent-encodes task thread ids in orchestrator links", () => {
			const resolver = buildInteractionUrlResolver("https://app.example");
			expect(
				resolver.resolveUrl?.({
					kind: "task",
					threadId: "a b/c?d",
					title: "T",
				}),
			).toBe("https://app.example/orchestrator?taskId=a%20b%2Fc%3Fd");
		});

		it("does not fabricate URLs for blocks without a hosted route", () => {
			const resolver = buildInteractionUrlResolver("https://app.example");
			expect(
				resolver.resolveUrl?.({ kind: "form", id: "r-form", fields: [] }),
			).toBeUndefined();
			expect(
				resolver.resolveUrl?.({
					kind: "secret",
					id: "r-secret",
					secretKind: "oauth",
				}),
			).toBeUndefined();
			expect(
				resolver.resolveUrl?.({
					kind: "choice",
					id: "r-choice",
					scope: "scope",
					options: [],
				}),
			).toBeUndefined();
			expect(
				resolver.resolveUrl?.({
					kind: "followups",
					id: "r-followups",
					options: [],
				}),
			).toBeUndefined();
		});

		it("maps navigate payloads to view routes and keeps dashboard paths", () => {
			const resolver = buildInteractionUrlResolver("https://app.example/");
			expect(resolver.resolveNavigateUrl?.("my view")).toBe(
				"https://app.example/?view=my%20view",
			);
			expect(resolver.resolveNavigateUrl?.("/settings/profile")).toBe(
				"https://app.example/settings/profile",
			);
			expect(resolver.resolveNavigateUrl?.("")).toBeUndefined();
		});
	});
});
