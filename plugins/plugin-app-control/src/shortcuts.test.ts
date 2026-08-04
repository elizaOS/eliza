/**
 * Natural-language shortcut tests for direct view navigation commands.
 */

import { matchShortcut } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { appControlPlugin } from "./index.ts";
import {
	FLASHLIGHT_OFF_SHORTCUT_ID,
	FLASHLIGHT_ON_SHORTCUT_ID,
	VIEW_NAVIGATION_SHORTCUT_ID,
	viewNavigationShortcuts,
} from "./shortcuts.ts";

const MATCH_CONTEXT = {
	allowNatural: true,
	actions: ["VIEWS"],
} as const;

describe("viewNavigationShortcuts (#8791)", () => {
	it("are registered on the app-control plugin", () => {
		expect(appControlPlugin.shortcuts).toEqual(viewNavigationShortcuts);
	});

	it("resolves explicit typed and ASR-normalized view navigation to VIEWS", () => {
		for (const phrase of [
			"open settings",
			"open notes",
			"go home",
			"go back",
			"return to the main screen",
			"open the home dashboard",
			"show me my calendar",
			"open calender",
			"hey can you open settings please",
			"open app builder",
			"check my messages",
			"go to my email",
			"what's on my calendar",
			"abre ajustes",
			"打开设置",
			"설정 열어",
		]) {
			const match = matchShortcut(
				viewNavigationShortcuts,
				phrase,
				MATCH_CONTEXT,
			);
			expect(match?.shortcut.id, phrase).toBe(VIEW_NAVIGATION_SHORTCUT_ID);
			expect(match?.shortcut.target).toEqual({
				kind: "action",
				name: "VIEWS",
				parameters: { action: "show" },
			});
			expect(match?.parameters.view, phrase).toBeUndefined();
			expect(match?.confidence).toBeGreaterThanOrEqual(0.9);
		}
	});

	it("keeps natural navigation shortcutting behind the global flag", () => {
		expect(
			matchShortcut(viewNavigationShortcuts, "open settings", {
				allowNatural: false,
				actions: ["VIEWS"],
			}),
		).toBeNull();
	});

	it.each([
		["turn on the flashlight", FLASHLIGHT_ON_SHORTCUT_ID, true],
		["can you switch the torch on", FLASHLIGHT_ON_SHORTCUT_ID, true],
		["flashlight on", FLASHLIGHT_ON_SHORTCUT_ID, true],
		["turn the flashlight off", FLASHLIGHT_OFF_SHORTCUT_ID, false],
		["switch off the torch", FLASHLIGHT_OFF_SHORTCUT_ID, false],
		["torch off", FLASHLIGHT_OFF_SHORTCUT_ID, false],
	] as const)(
		"routes %s directly to the Android device capability",
		(phrase, shortcutId, enabled) => {
			const match = matchShortcut(
				viewNavigationShortcuts,
				phrase,
				MATCH_CONTEXT,
			);
			expect(match?.shortcut.id).toBe(shortcutId);
			expect(match?.shortcut.target).toEqual({
				kind: "action",
				name: "VIEWS",
				parameters: {
					action: "interact",
					view: "device-control",
					capability: "set-flashlight",
					params: { enabled },
				},
			});
		},
	);

	it("falls through when VIEWS is unavailable or the phrase is not navigation", () => {
		expect(
			matchShortcut(viewNavigationShortcuts, "open settings", {
				allowNatural: true,
				actions: ["REPLY"],
			}),
		).toBeNull();
		expect(
			matchShortcut(viewNavigationShortcuts, "tell me a joke", MATCH_CONTEXT),
		).toBeNull();
		expect(
			matchShortcut(viewNavigationShortcuts, "back", MATCH_CONTEXT),
		).toBeNull();
		expect(
			matchShortcut(
				viewNavigationShortcuts,
				"go back over the paragraph",
				MATCH_CONTEXT,
			),
		).toBeNull();
	});
});
