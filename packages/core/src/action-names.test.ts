/**
 * Deterministic test pinning the reserved action-name constants and the
 * canonical ordering of `NON_EXECUTABLE_RESPONSE_ACTION_NAMES`.
 */

import { describe, expect, it } from "vitest";
import {
	IGNORE_ACTION_NAME,
	NON_EXECUTABLE_RESPONSE_ACTION_NAMES,
	NONE_ACTION_NAME,
	REPLY_ACTION_NAME,
} from "./action-names";

describe("action name contracts", () => {
	it("exports the non-executable response action names in canonical order", () => {
		expect(NON_EXECUTABLE_RESPONSE_ACTION_NAMES).toEqual([
			REPLY_ACTION_NAME,
			NONE_ACTION_NAME,
			IGNORE_ACTION_NAME,
		]);
	});
});
