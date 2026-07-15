/**
 * Unit tests for the voice/text shortcut matcher (`normalizeForMatch`,
 * `compileTemplate`, `matchShortcut`, `ShortcutRegistry`): the always-on explicit
 * slash-command tier, the caller-enabled natural-language tier with slot
 * extraction and a confidence floor, and action/context/auth gating. Pure
 * deterministic functions — no model, no DB.
 */

import { describe, expect, it } from "vitest";
import type { ShortcutDefinition } from "../types/shortcut";
import {
	compileTemplate,
	matchShortcut,
	normalizeForMatch,
	ShortcutRegistry,
	stripLeadingMentionForShortcut,
} from "./shortcut-registry";

const settingsExplicit: ShortcutDefinition = {
	id: "cmd:settings",
	kind: "explicit",
	aliases: ["/settings", "/set"],
	target: { kind: "navigate", path: "/settings" },
};

const openSettingsNatural: ShortcutDefinition = {
	id: "nav:open-settings",
	kind: "natural",
	patterns: [{ template: "open {section}" }, { template: "go to {section}" }],
	target: { kind: "action", name: "VIEWS" },
	confidence: 0.85,
};

describe("normalizeForMatch (ASR-tolerant)", () => {
	it("lowercases, strips punctuation, collapses whitespace", () => {
		expect(normalizeForMatch("  Open   Settings!! ")).toBe("open settings");
	});
	it("strips leading wake/filler words", () => {
		expect(normalizeForMatch("hey can you open settings")).toBe(
			"open settings",
		);
		expect(normalizeForMatch("please open settings")).toBe("open settings");
	});
	it("strips a trailing please", () => {
		expect(normalizeForMatch("open settings please")).toBe("open settings");
	});
});

describe("compileTemplate", () => {
	it("matches a single slot and captures it", () => {
		const re = compileTemplate("open {section}");
		const m = "open billing settings".match(re);
		expect(m?.groups?.section).toBe("billing settings");
	});
	it("handles multiple slots", () => {
		const re = compileTemplate("set {field} to {level}");
		const m = "set thinking to high".match(re);
		expect(m?.groups?.field).toBe("thinking");
		expect(m?.groups?.level).toBe("high");
	});
	it("does not match unrelated text", () => {
		expect(
			"close the door".match(compileTemplate("open {section}")),
		).toBeNull();
	});
});

describe("matchShortcut — explicit tier (always-on)", () => {
	const defs = [settingsExplicit, openSettingsNatural];
	it("matches a bare slash alias", () => {
		const m = matchShortcut(defs, "/settings");
		expect(m?.shortcut.id).toBe("cmd:settings");
		expect(m?.confidence).toBe(1);
	});
	it("matches a slash alias with trailing args", () => {
		expect(matchShortcut(defs, "/settings billing")?.shortcut.id).toBe(
			"cmd:settings",
		);
		expect(matchShortcut(defs, "/set:billing")?.shortcut.id).toBe(
			"cmd:settings",
		);
	});
	it("does not match plain text as an explicit command", () => {
		expect(matchShortcut(defs, "settings please")).toBeNull();
	});
	it("explicit matches even when natural is disabled", () => {
		expect(
			matchShortcut(defs, "/settings", { allowNatural: false }),
		).not.toBeNull();
	});
	it("higher priority wins among explicit matches", () => {
		const a: ShortcutDefinition = {
			id: "a",
			kind: "explicit",
			aliases: ["/x"],
			target: { kind: "action", name: "A" },
			priority: 1,
		};
		const b: ShortcutDefinition = {
			id: "b",
			kind: "explicit",
			aliases: ["/x"],
			target: { kind: "action", name: "B" },
			priority: 5,
		};
		expect(matchShortcut([a, b], "/x")?.shortcut.id).toBe("b");
	});

	// #16172 gap 1: a leading connector-native mention must not defeat the
	// deterministic explicit shortcut (strict-mention Discord requires `<@bot>`).
	it("matches an explicit alias behind a leading <@id> mention", () => {
		expect(matchShortcut(defs, "<@123> /settings")?.shortcut.id).toBe(
			"cmd:settings",
		);
	});
	it("matches an explicit alias behind a leading <@!id> nickname mention", () => {
		expect(matchShortcut(defs, "<@!123> /set billing")?.shortcut.id).toBe(
			"cmd:settings",
		);
	});
	it("matches a mention-prefixed alias even when natural is disabled", () => {
		expect(
			matchShortcut(defs, "<@123> /settings", { allowNatural: false })?.shortcut
				.id,
		).toBe("cmd:settings");
	});
	it("does not strip a mention that is part of an argument", () => {
		// `/settings <@123>` still matches /settings (the mention is an arg), and
		// the leading-mention strip must not corrupt it into a non-match.
		expect(matchShortcut(defs, "/settings <@123>")?.shortcut.id).toBe(
			"cmd:settings",
		);
	});
});

describe("stripLeadingMentionForShortcut (#16172)", () => {
	it("strips a leading <@id> and its whitespace", () => {
		expect(stripLeadingMentionForShortcut("<@123> /model show")).toBe(
			"/model show",
		);
	});
	it("strips a leading <@!id> nickname mention", () => {
		expect(stripLeadingMentionForShortcut("<@!42> /help")).toBe("/help");
	});
	it("leaves an inner mention untouched", () => {
		expect(stripLeadingMentionForShortcut("/model <@123>")).toBe(
			"/model <@123>",
		);
	});
});

describe("matchShortcut — natural tier (caller-enabled)", () => {
	const defs = [openSettingsNatural];
	it("does not fire when natural is disabled (default)", () => {
		expect(matchShortcut(defs, "open settings")).toBeNull();
	});
	it("fires + extracts slot when natural is enabled", () => {
		const m = matchShortcut(defs, "open settings", { allowNatural: true });
		expect(m?.shortcut.id).toBe("nav:open-settings");
		expect(m?.parameters.section).toBe("settings");
		expect(m?.confidence).toBe(0.85);
	});
	it("matches ASR-style input (no punctuation, leading filler)", () => {
		const m = matchShortcut(defs, "hey open settings please", {
			allowNatural: true,
		});
		expect(m?.shortcut.id).toBe("nav:open-settings");
	});
	it("refuses ambiguous near-ties at equal priority (defers to LLM)", () => {
		const x: ShortcutDefinition = {
			id: "x",
			kind: "natural",
			patterns: [{ template: "open {thing}", confidence: 0.8 }],
			target: { kind: "action", name: "X" },
		};
		const y: ShortcutDefinition = {
			id: "y",
			kind: "natural",
			patterns: [{ template: "open {item}", confidence: 0.8 }],
			target: { kind: "action", name: "Y" },
		};
		expect(
			matchShortcut([x, y], "open wallet", { allowNatural: true }),
		).toBeNull();
	});
	it("rejects matches below the confidence floor", () => {
		const low: ShortcutDefinition = {
			id: "low",
			kind: "natural",
			patterns: [{ template: "open {thing}", confidence: 0.4 }],
			target: { kind: "action", name: "Z" },
		};
		expect(
			matchShortcut([low], "open wallet", { allowNatural: true }),
		).toBeNull();
	});
});

describe("matchShortcut — gating", () => {
	it("skips a shortcut whose required action is not registered", () => {
		const m = matchShortcut([openSettingsNatural], "open settings", {
			allowNatural: true,
			actions: ["REPLY"],
		});
		expect(m).toBeNull();
		const ok = matchShortcut([openSettingsNatural], "open settings", {
			allowNatural: true,
			actions: ["VIEWS"],
		});
		expect(ok?.shortcut.id).toBe("nav:open-settings");
	});
	it("enforces requiresContext (active view)", () => {
		const viewScoped: ShortcutDefinition = {
			id: "vs",
			kind: "explicit",
			aliases: ["/add"],
			target: { kind: "action", name: "ADD" },
			requiresContext: ["calendar"],
		};
		expect(matchShortcut([viewScoped], "/add")).toBeNull();
		expect(
			matchShortcut([viewScoped], "/add", { view: "calendar" })?.shortcut.id,
		).toBe("vs");
	});
	it("enforces requiresAuth", () => {
		const authed: ShortcutDefinition = {
			id: "auth",
			kind: "explicit",
			aliases: ["/danger"],
			target: { kind: "action", name: "DANGER" },
			requiresAuth: true,
		};
		expect(matchShortcut([authed], "/danger")).toBeNull();
		expect(
			matchShortcut([authed], "/danger", { isAuthorized: true })?.shortcut.id,
		).toBe("auth");
	});
});

describe("ShortcutRegistry", () => {
	it("registers, lists, and matches per-agent", () => {
		const reg = new ShortcutRegistry();
		reg.registerMany([settingsExplicit, openSettingsNatural]);
		expect(reg.size).toBe(2);
		expect(reg.match("/settings")?.shortcut.id).toBe("cmd:settings");
		reg.unregister("cmd:settings");
		expect(reg.match("/settings")).toBeNull();
		reg.clear();
		expect(reg.size).toBe(0);
	});
});
