/**
 * Parameter normalization tests for app launch and close target extraction.
 */

import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	extractCloseTarget,
	extractLaunchTarget,
	normalizeActionOptions,
	readStringOption,
} from "./params.js";

const msg = (text: string): Memory =>
	({ content: { text } }) as unknown as Memory;

const wrappedRequest = (request: string): string =>
	[
		"Answer the user request using the contextual documents below as the source of truth.",
		"<contextual_documents>open inbox and close settings</contextual_documents>",
		`<user_request>${request}</user_request>`,
	].join("\n");

describe("normalizeActionOptions", () => {
	it("unwraps a nested parameters object, else returns options as-is", () => {
		expect(normalizeActionOptions(undefined)).toBeUndefined();
		expect(normalizeActionOptions({ app: "x" })).toEqual({ app: "x" });
		expect(normalizeActionOptions({ parameters: { app: "x" } })).toEqual({
			app: "x",
		});
		// An array `parameters` is not treated as the nested bag.
		expect(normalizeActionOptions({ parameters: ["x"] })).toEqual({
			parameters: ["x"],
		});
	});
});

describe("readStringOption", () => {
	it("returns trimmed non-empty strings, null otherwise", () => {
		expect(readStringOption({ app: "  Wallet  " }, "app")).toBe("Wallet");
		expect(readStringOption({ app: "   " }, "app")).toBeNull();
		expect(readStringOption({ app: 42 }, "app")).toBeNull();
		expect(readStringOption(undefined, "app")).toBeNull();
		expect(readStringOption({ parameters: { app: "Calc" } }, "app")).toBe(
			"Calc",
		);
	});
});

describe("extractLaunchTarget", () => {
	it("prefers options.app, then options.name, then the message verb", () => {
		expect(
			extractLaunchTarget(msg("launch calculator"), { app: "wallet" }),
		).toBe("wallet");
		expect(
			extractLaunchTarget(msg("launch calculator"), { name: "wallet" }),
		).toBe("wallet");
		expect(extractLaunchTarget(msg("please open the Calculator app"), {})).toBe(
			"calculator",
		);
	});

	it("peels filler words and lowercases the resolved name", () => {
		expect(
			extractLaunchTarget(msg("fire up the mini Wallet overlay"), undefined),
		).toBe("wallet");
	});

	it("extracts the command from a document-augmented user_request", () => {
		expect(
			extractLaunchTarget(
				msg(wrappedRequest("open the Calendar app")),
				undefined,
			),
		).toBe("calendar");
	});

	it("returns null when no verb, no option, or only fillers follow", () => {
		expect(extractLaunchTarget(msg("hello there"), undefined)).toBeNull();
		expect(
			extractLaunchTarget(msg("open the app please"), undefined),
		).toBeNull();
		expect(extractLaunchTarget(undefined, undefined)).toBeNull();
	});
});

describe("extractCloseTarget", () => {
	it("splits runId from the app name and honors close verbs", () => {
		expect(
			extractCloseTarget(msg("close calculator"), { runId: "r-1" }),
		).toEqual({
			runId: "r-1",
			appName: "calculator",
		});
		expect(extractCloseTarget(msg("kill the Wallet app"), undefined)).toEqual({
			runId: null,
			appName: "wallet",
		});
	});

	it("yields null fields when nothing resolves", () => {
		expect(extractCloseTarget(msg("nothing to do"), undefined)).toEqual({
			runId: null,
			appName: null,
		});
	});

	it("ignores contextual document commands when closing an app", () => {
		expect(
			extractCloseTarget(
				msg(wrappedRequest("close the Calendar app")),
				undefined,
			),
		).toEqual({ runId: null, appName: "calendar" });
	});
});
