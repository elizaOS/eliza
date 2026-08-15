import assert from "node:assert/strict";

function ranNonSilentAction(actionResults, suppressesPlannerReply = false) {
	return (
		actionResults.some((result) => result.success === true) &&
		!suppressesPlannerReply
	);
}

assert.equal(
	ranNonSilentAction([
		{ success: false, data: { error: "first tool failed" } },
		{ success: false, data: { error: "second tool failed" } },
	]),
	false,
	"all failed actions must not count as successful work",
);
assert.equal(
	ranNonSilentAction([{ success: true, data: { value: "done" } }]),
	true,
	"a successful action must count as successful work",
);
assert.equal(
	ranNonSilentAction([]),
	false,
	"an empty action result list must not count as successful work",
);
assert.equal(
	ranNonSilentAction([
		{ success: false, data: { error: "tool failed" } },
		{ success: true, data: { value: "done" } },
	]),
	true,
	"mixed results must count when at least one action succeeded",
);
assert.equal(
	ranNonSilentAction([{ success: true }], true),
	false,
	"planner-reply suppression must still take precedence",
);

console.log("zero-delivery recovery verification passed");
