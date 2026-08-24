/**
 * Covers Stage-1 routing: routeMessageHandlerOutput's simple-reply vs planning vs
 * ignore/stop decisions (including requiresTool / candidateActions promotion and
 * the addressed-to-other engagement gate), and parseMessageHandlerOutput's
 * flat-envelope plus extract parsing. Deterministic — routes fixed output
 * objects, no model.
 */
import { describe, expect, it } from "vitest";
import { HANDLE_RESPONSE_SCHEMA } from "../../actions/to-tool";
import {
	getMessageHandlerReply,
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
	SIMPLE_CONTEXT_ID,
} from "../message-handler";

describe("v5 message handler routing", () => {
	it("returns final reply when contexts is exactly ['simple']", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Direct answer.",
			plan: { contexts: [SIMPLE_CONTEXT_ID], reply: "Hello." },
			contexts: [SIMPLE_CONTEXT_ID],
			reply: "Hello.",
		};

		expect(routeMessageHandlerOutput(output)).toEqual({
			type: "final_reply",
			reply: "Hello.",
			output,
		});
	});

	it("returns final reply when contexts is empty (defensive)", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Direct answer.",
			plan: { contexts: [], reply: "Hello." },
			contexts: [],
			reply: "Hello.",
		};

		expect(routeMessageHandlerOutput(output).type).toBe("final_reply");
	});

	it("plans when any non-simple context is present", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Calendar context is needed.",
			plan: { contexts: ["calendar"] },
			contexts: ["calendar"],
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["calendar"]);
		}
	});

	it("plans against 'general' when requiresTool=true and contexts is empty", () => {
		// Stage 1's escape hatch: even when the model didn't pick any context,
		// `requiresTool: true` forces planning so the planner can attempt a tool.
		const output = {
			processMessage: "RESPOND" as const,
			thought: "Needs a tool.",
			plan: { contexts: [], requiresTool: true },
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["general"]);
		}
	});

	it("plans against 'general' when candidateActions has validated tools, even if Stage 1 also routed simple-path", () => {
		// Live regression on 2026-05-25 (trajectories tj-c227b5bbff288a and
		// tj-d5e298b2542aa0). Probes "find files in /etc that contain the word
		// hostname" and "what files are in /tmp right now" produced the
		// self-contradictory envelope after validation:
		//   { contexts:["simple"], requiresTool:true, candidateActions:["BASH"],
		//     replyText:"On it." }
		// The model claimed simple-path (so no planner ran) while ALSO naming
		// a specific exposed tool that could fulfill the request. The user saw
		// only "On it." and nothing else because no planner iteration ever
		// executed BASH. Resolve the contradiction in favor of running the
		// planner — the candidateActions hint is a concrete reference to an
		// exposed tool and outranks the simple-path flag.
		const output = {
			processMessage: "RESPOND" as const,
			thought: "Tool would help here.",
			plan: {
				contexts: ["simple"],
				requiresTool: true,
				candidateActions: ["BASH"],
				reply: "On it.",
			},
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["general"]);
		}
	});

	it("ignores an addressed-to-other simple turn instead of shipping the reply (engagement gate)", () => {
		// Live incident: in a busy group channel Stage 1 tagged turns as
		// addressed to another participant yet the simple-path replyText still
		// shipped ungated — 27 posts in 20 minutes. An overheard turn must
		// terminal-route to ignored, not reply.
		const output = {
			processMessage: "RESPOND" as const,
			thought: "Overheard turn.",
			plan: { contexts: [SIMPLE_CONTEXT_ID], reply: "Hello." },
		};

		expect(routeMessageHandlerOutput(output).type).toBe("final_reply");
		expect(
			routeMessageHandlerOutput(output, {
				addressedToOtherParticipant: true,
			}),
		).toEqual({ type: "ignored", output });
	});

	it("ignores an addressed-to-other mixed-context turn so the planner is never entered (engagement gate)", () => {
		// The mixed-context planning_needed branch was completely ungated: an
		// overheard turn must not enter the planner or execute tools either.
		const output = {
			processMessage: "RESPOND" as const,
			thought: "Overheard turn with tool hints.",
			plan: {
				contexts: [SIMPLE_CONTEXT_ID, "calendar"],
				candidateActions: ["CALENDAR"],
				reply: "on it",
			},
		};

		expect(routeMessageHandlerOutput(output).type).toBe("planning_needed");
		expect(
			routeMessageHandlerOutput(output, {
				addressedToOtherParticipant: true,
			}).type,
		).toBe("ignored");
	});

	it("subsumes the #9874 tool-promotion suppression: an addressed-to-other promotion-shaped turn is ignored, not replied", () => {
		// Previously suppressToolPromotion blocked only the simple→tool
		// promotion while still shipping the Stage-1 reply to a turn meant for
		// someone else. The gate is a superset: the whole turn is ignored.
		const output = {
			processMessage: "RESPOND" as const,
			thought: "Overheard crosstalk.",
			plan: {
				contexts: ["simple"],
				requiresTool: true,
				candidateActions: ["BASH"],
				reply: "got it",
			},
		};

		expect(routeMessageHandlerOutput(output).type).toBe("planning_needed");
		expect(
			routeMessageHandlerOutput(output, {
				addressedToOtherParticipant: true,
			}).type,
		).toBe("ignored");
	});

	it("leaves every route unchanged when the turn is not addressed to another participant", () => {
		// Non-nanny regression: addressedTo:[] (undirected banter) and turns
		// naming the agent resolve to addressedToOtherParticipant=false — the
		// gate must be a strict no-op there.
		const simple = {
			processMessage: "RESPOND" as const,
			thought: "Undirected banter.",
			plan: { contexts: [SIMPLE_CONTEXT_ID], reply: "Hello." },
		};
		expect(
			routeMessageHandlerOutput(simple, {
				addressedToOtherParticipant: false,
			}),
		).toEqual({ type: "final_reply", reply: "Hello.", output: simple });

		const planning = {
			processMessage: "RESPOND" as const,
			thought: "real context.",
			plan: { contexts: ["general"], requiresTool: true },
		};
		expect(
			routeMessageHandlerOutput(planning, {
				addressedToOtherParticipant: false,
			}).type,
		).toBe("planning_needed");
	});

	it("keeps simple route for explicit non-tool candidate hints", () => {
		const output = {
			processMessage: "RESPOND" as const,
			thought: "No runnable tool.",
			plan: {
				contexts: ["simple"],
				requiresTool: false,
				candidateActions: ["REFUSE"],
				reply: "I can't help with that.",
			},
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("final_reply");
		if (route.type === "final_reply") {
			expect(route.reply).toBe("I can't help with that.");
		}
	});

	it("keeps the simple-path final-reply route when candidateActions is empty and requiresTool is false", () => {
		// Defensive: the candidateActions-based promotion above must not
		// accidentally drag legitimate simple-path replies into the planner.
		// An empty/missing candidateActions field is the common case for
		// every chat, math, recall, joke, and definition probe.
		const output = {
			processMessage: "RESPOND" as const,
			thought: "Direct chat answer.",
			plan: {
				contexts: ["simple"],
				requiresTool: false,
				reply: "8 times 9 is 72.",
			},
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("final_reply");
		if (route.type === "final_reply") {
			expect(route.reply).toBe("8 times 9 is 72.");
		}
	});

	it("promotes a short progress-shaped ack on the pure-simple path to planning", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "checking paris weather now",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		const route = routeMessageHandlerOutput(parsed);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["general"]);
		}
	});

	it("keeps a conversational let-me-know close as a final reply", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "let me know if you need anything else",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		expect(routeMessageHandlerOutput(parsed).type).toBe("final_reply");
	});

	it("does not force planning for explanatory gerunds that are substantive answers", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText:
					"Checking accounts are bank accounts designed for frequent deposits and withdrawals.",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);

		expect(parsed).toMatchObject({
			processMessage: "RESPOND",
			plan: {
				contexts: ["simple"],
				reply:
					"Checking accounts are bank accounts designed for frequent deposits and withdrawals.",
			},
		});
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		const route = routeMessageHandlerOutput(parsed);
		expect(route.type).toBe("final_reply");
	});

	it("does not parse retired requiresTool from the model envelope", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				thought: "Tool needed.",
				replyText: "",
				contexts: ["general"],
				requiresTool: true,
			}),
		);
		expect(parsed?.plan?.requiresTool).toBeUndefined();
	});

	it("strips 'simple' from a mixed selection before planning", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Mixed.",
			plan: { contexts: [SIMPLE_CONTEXT_ID, "email"] },
			contexts: [SIMPLE_CONTEXT_ID, "email"],
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["email"]);
		}
	});

	it("parses canonical contexts: ['simple'] flat envelope output", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Done.",
				contexts: ["simple"],
			}),
		);
		expect(parsed).toMatchObject({
			processMessage: "RESPOND",
			thought: "",
			plan: { contexts: ["simple"], reply: "Done." },
		});
	});

	it("uses the canonical response-handler field envelope in the Stage 1 tool schema", () => {
		const props = HANDLE_RESPONSE_SCHEMA.properties as Record<string, unknown>;
		const keys = Object.keys(props);
		expect(keys).toEqual([
			"shouldRespond",
			"contexts",
			"intents",
			"replyText",
			"replyEffectStatus",
			"candidateActionNames",
			"facts",
			"relationships",
			"topics",
			"addressedTo",
			"emotion",
		]);
		expect(HANDLE_RESPONSE_SCHEMA.required).toEqual([
			"shouldRespond",
			"contexts",
			"intents",
			"replyText",
			"replyEffectStatus",
			"candidateActionNames",
			"facts",
			"relationships",
			"topics",
			"addressedTo",
			"emotion",
		]);
		expect(props.plan).toBeUndefined();
		expect(props.contextSlices).toBeUndefined();
		expect(props.candidateActions).toBeUndefined();
		expect(props.parentActionHints).toBeUndefined();
		expect(props.requiresTool).toBeUndefined();
		expect(props.extract).toBeUndefined();
	});

	it("parses the flat HANDLE_RESPONSE envelope (shouldRespond/replyText/contexts)", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Hello there.",
				contexts: ["simple"],
			}),
		);
		expect(parsed?.processMessage).toBe("RESPOND");
		expect(parsed?.thought).toBe("");
		expect(parsed?.plan.contexts).toEqual(["simple"]);
		expect(parsed?.plan.reply).toBe("Hello there.");
		expect(parsed?.plan.requiresTool).toBeUndefined();
	});

	it("does not pass JSON structural punctuation through as reply text", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "}",
				contexts: ["simple"],
			}),
		);

		expect(parsed?.plan.reply).toBe("");
	});

	it("parses the canonical field envelope with action hints and memory fields", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "On it.",
				contexts: ["calendar"],
				candidateActionNames: ["calendar_create_event"],
				facts: ["the user prefers morning meetings"],
				relationships: [],
				addressedTo: [],
			}),
		);
		expect(parsed?.plan.contexts).toEqual(["calendar"]);
		expect(parsed?.plan.reply).toBe("On it.");
		expect(parsed?.plan.candidateActions).toEqual(["calendar_create_event"]);
		expect(parsed?.plan.parentActionHints).toBeUndefined();
		expect(parsed?.plan.contextSlices).toBeUndefined();
		expect(parsed?.plan.requiresTool).toBeUndefined();
		expect(parsed?.extract?.facts).toEqual([
			"the user prefers morning meetings",
		]);
	});

	// No refusal-sanitization repair runs on the planning path: under
	// `toolChoice: "required"` + per-turn action tools the model picks the right
	// tool directly, so there is no "model contradicts its own routing decision"
	// case to repair.

	it("maps shouldRespond IGNORE/STOP through routing", () => {
		const ignore = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "IGNORE",
				replyText: "",
				contexts: [],
			}),
		);
		if (!ignore) throw new Error("expected parsed IGNORE output");
		expect(ignore.processMessage).toBe("IGNORE");
		expect(routeMessageHandlerOutput(ignore).type).toBe("ignored");

		const stop = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "STOP",
				replyText: "",
				contexts: [],
			}),
		);
		if (!stop) throw new Error("expected parsed STOP output");
		expect(stop.processMessage).toBe("STOP");
		expect(routeMessageHandlerOutput(stop).type).toBe("stopped");
	});

	it("plans against general when Stage 1 marks an otherwise simple route as tool-required", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Needs a tool.",
			plan: { contexts: [SIMPLE_CONTEXT_ID], requiresTool: true },
			contexts: [SIMPLE_CONTEXT_ID],
		};

		const route = routeMessageHandlerOutput(output);

		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["general"]);
		}
	});

	it("parses extract.facts and extract.relationships when present", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["memory"],
				facts: ["the user's birthday is 1990-03-05", "  ", ""],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
					{ subject: "user", predicate: "", object: "Bob" },
				],
			}),
		);
		expect(parsed?.extract?.facts).toEqual([
			"the user's birthday is 1990-03-05",
		]);
		expect(parsed?.extract?.relationships).toEqual([
			{ subject: "user", predicate: "works_with", object: "Alice" },
		]);
	});

	it("omits extract when no facts or relationships were emitted", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "hi",
				contexts: ["simple"],
			}),
		);
		expect(parsed?.extract).toBeUndefined();
	});
});

describe("explicit media-ask promotion", () => {
	it("promotes a poisoned capability denial on the simple path to media planning", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText:
					"can't do that here. no video generation tools in this setup.",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		const route = routeMessageHandlerOutput(parsed, {
			messageText: "generate a 3 second video of falling leaves",
		});
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["media"]);
			expect(route.output.plan.candidateActions).toContain("GENERATE_MEDIA");
		}
	});

	it("seeds GENERATE_MEDIA as a candidate on planned media asks", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "on it",
				contexts: ["general"],
				candidateActionNames: ["WORKFLOW"],
			}),
		);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		const route = routeMessageHandlerOutput(parsed, {
			messageText: "make a short video of ocean waves",
		});
		expect(route.type).toBe("planning_needed");
		expect(route.output.plan.candidateActions).toContain("GENERATE_MEDIA");
	});

	it("leaves non-media asks and clarifying replies untouched", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "sure — a picture of what exactly?",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		const route = routeMessageHandlerOutput(parsed, {
			messageText: "generate an image of a fox",
		});
		expect(route.type).toBe("final_reply");
	});

	it("does not seed media candidates for incidental media mentions", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "here you go",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		const route = routeMessageHandlerOutput(parsed, {
			messageText: "send me the image you saved yesterday",
		});
		expect(route.type).toBe("final_reply");
		expect(route.output.plan.candidateActions ?? []).not.toContain(
			"GENERATE_MEDIA",
		);
	});
});

describe("plain-text keyed transcript recovery (#11712)", () => {
	it("parses a raw keyed transcript echo instead of letting it ship verbatim", () => {
		const parsed = parseMessageHandlerOutput(
			[
				"shouldRespond: RESPOND",
				"",
				"replyText: it's live https://example/",
				"",
				"contexts: simple",
				"",
				"candidateActionNames: BASH, TASKS",
			].join("\n"),
		);
		expect(parsed?.processMessage).toBe("RESPOND");
		expect(parsed?.thought).toBe("");
		expect(parsed?.plan.contexts).toEqual(["simple"]);
		expect(parsed?.plan.reply).toBe("it's live https://example/");
		expect(parsed?.plan.candidateActions).toEqual(["BASH", "TASKS"]);
	});

	it("preserves a multi-line replyText value containing embedded blank lines", () => {
		const parsed = parseMessageHandlerOutput(
			[
				"shouldRespond: RESPOND",
				"",
				"replyText: built it out at /workspace",
				"",
				"go click around and tell me what breaks.",
				"",
				"contexts: simple",
			].join("\n"),
		);
		expect(parsed?.plan.reply).toBe(
			"built it out at /workspace\n\ngo click around and tell me what breaks.",
		);
	});

	it("recovers an IGNORE echo whose list fields read 'none' as empty selections", () => {
		const parsed = parseMessageHandlerOutput(
			"shouldRespond: IGNORE\n\ncontexts: none",
		);
		if (!parsed) throw new Error("expected parsed transcript output");
		expect(parsed.processMessage).toBe("IGNORE");
		expect(parsed.plan.contexts).toEqual([]);
		expect(routeMessageHandlerOutput(parsed)).toEqual({
			type: "ignored",
			output: parsed,
		});
	});

	it("returns null for prose that merely quotes field lines, keeping the tolerant plain-text path intact", () => {
		const raw = [
			"You pasted what looks like a leaked transcript.",
			"",
			"shouldRespond: RESPOND",
			"",
			"replyText: hello",
		].join("\n");
		expect(parseMessageHandlerOutput(raw)).toBeNull();
	});

	it("returns null when transcript-shaped text carries only non-hallmark fields", () => {
		const raw = ["topics: website build, aurora", "", "emotion: none"].join(
			"\n",
		);
		expect(parseMessageHandlerOutput(raw)).toBeNull();
	});
});

describe("hint-array rejection contract", () => {
	it("rejects the envelope when candidateActionNames is not an array", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "On it.",
				contexts: ["general"],
				candidateActionNames: "BASH",
			}),
		);
		expect(parsed).toBeNull();
	});

	it("rejects the envelope when candidateActionNames contains a non-string item", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "On it.",
				contexts: ["general"],
				candidateActionNames: ["BASH", 7],
			}),
		);
		expect(parsed).toBeNull();
	});

	it("rejects the envelope when intents contains a non-string item", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "On it.",
				contexts: ["general"],
				intents: ["delete reminder", 42],
			}),
		);
		expect(parsed).toBeNull();
	});

	it("omits the candidateActions and intents keys when neither hint was sent", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Hello.",
				contexts: ["simple"],
			}),
		);
		expect(parsed?.plan.candidateActions).toBeUndefined();
		expect(parsed?.plan.intents).toBeUndefined();
	});
});

describe("intents propagation", () => {
	it("carries declared intents through to the plan in order", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "On both.",
				contexts: ["general"],
				intents: ["delete reminder", "create reminder"],
			}),
		);
		expect(parsed?.plan.intents).toEqual([
			"delete reminder",
			"create reminder",
		]);
	});

	it("omits the intents key when Stage 1 declares none", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Done.",
				contexts: ["simple"],
				intents: [],
			}),
		);
		expect(parsed?.plan.intents).toBeUndefined();
	});
});

describe("reminder-ask denial promotion", () => {
	it("promotes a capability denial for an explicit reminder ask to tasks planning and seeds both reminder siblings", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "I don't have a reminder tool in this setup.",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		if (!parsed) throw new Error("expected parsed output");
		const route = routeMessageHandlerOutput(parsed, {
			messageText: "remind me to stretch in 20 minutes",
		});
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["tasks"]);
			expect(route.output.plan.candidateActions).toContain("OWNER_REMINDERS");
			expect(route.output.plan.candidateActions).toContain("TRIGGER");
			expect(route.output.plan.candidateActions).not.toContain(
				"GENERATE_MEDIA",
			);
		}
	});

	it("keeps the same denial a final reply when the user did not ask for a reminder", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "I don't have a reminder tool in this setup.",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		if (!parsed) throw new Error("expected parsed output");
		expect(routeMessageHandlerOutput(parsed).type).toBe("final_reply");
	});
});

describe("task-status claim promotion", () => {
	it("promotes a task-state claim for an explicit status ask to tasks planning and seeds TASKS", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "no such task exists right now.",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		if (!parsed) throw new Error("expected parsed output");
		const route = routeMessageHandlerOutput(parsed, {
			messageText: "did the website build finish?",
		});
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["tasks"]);
			expect(route.output.plan.candidateActions).toContain("TASKS");
		}
	});

	it("keeps an unprompted task-state claim a final reply", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "no such task exists right now.",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		if (!parsed) throw new Error("expected parsed output");
		expect(routeMessageHandlerOutput(parsed).type).toBe("final_reply");
	});
});

describe("shouldRespond normalization fallbacks", () => {
	it("defaults an unrecognized routing verb to RESPOND", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "MAYBE",
				replyText: "Hello.",
				contexts: ["simple"],
			}),
		);
		expect(parsed?.processMessage).toBe("RESPOND");
	});

	it("normalizes lowercase routing verbs before routing", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "ignore",
				replyText: "",
				contexts: [],
			}),
		);
		if (!parsed) return;
		expect(parsed.processMessage).toBe("IGNORE");
		expect(routeMessageHandlerOutput(parsed).type).toBe("ignored");
	});
});

describe("context normalization in the JSON envelope", () => {
	it("trims context entries and drops blank ones", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Hello.",
				contexts: [" simple ", "", "calendar "],
			}),
		);
		expect(parsed?.plan.contexts).toEqual(["simple", "calendar"]);
	});

	it("collapses a non-array contexts value to an empty selection", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Hello.",
				contexts: "general",
			}),
		);
		expect(parsed?.plan.contexts).toEqual([]);
	});
});

describe("getMessageHandlerReply", () => {
	it("trims surrounding whitespace from the planned reply", () => {
		expect(
			getMessageHandlerReply({
				processMessage: "RESPOND",
				thought: "",
				plan: { contexts: [], reply: "  padded reply  " },
			}),
		).toBe("padded reply");
	});

	it("yields an empty string when the plan carries no reply", () => {
		expect(
			getMessageHandlerReply({
				processMessage: "RESPOND",
				thought: "",
				plan: { contexts: [] },
			}),
		).toBe("");
	});
});

describe("progress-ack length cap", () => {
	it("keeps a long progress-opener answer a final reply instead of promoting it", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText:
					"checking the forecast, fetching your calendar, and gathering your notes now",
				contexts: ["simple"],
				candidateActionNames: [],
			}),
		);
		if (!parsed) throw new Error("expected parsed output");
		const route = routeMessageHandlerOutput(parsed);
		expect(route.type).toBe("final_reply");
		if (route.type === "final_reply") {
			expect(route.reply).toBe(
				"checking the forecast, fetching your calendar, and gathering your notes now",
			);
		}
	});
});

describe("candidate-action promotion arm", () => {
	it("promotes to general planning when candidates are named and requiresTool is unset rather than false", () => {
		const output = {
			processMessage: "RESPOND" as const,
			thought: "Tool hinted, flag omitted.",
			plan: {
				contexts: [SIMPLE_CONTEXT_ID],
				candidateActions: ["BASH"],
				reply: "On it.",
			},
		};
		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["general"]);
		}
	});
});
