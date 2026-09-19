/**
 * Exercises the installed redaction leaf in ordinary Node against a packed core
 * tarball. The build copies this consumer outside the workspace so source
 * aliases and unshipped files cannot satisfy the logger's import boundary.
 */
import assert from "node:assert/strict";
import {
	isSensitiveKeyName,
	redactLogArgs,
} from "@elizaos/core/security/redact";

const credential = ["fixture", "credential", "redaction", "only"].join("-");
const original = {
	requestId: "request-42",
	apiKey: credential,
	diagnostic: { message: "delivery unavailable", retries: 2, enabled: false },
};
const input = ["request failed", original, null, 0];
const actual = redactLogArgs(input);
assert.equal(isSensitiveKeyName("apiKey"), true);
assert.equal(isSensitiveKeyName("requestId"), false);
assert.equal(JSON.stringify(actual).includes(credential), false);
assert.deepEqual(JSON.parse(JSON.stringify(actual)), [
	"request failed",
	{
		requestId: "request-42",
		apiKey: "[REDACTED]",
		diagnostic: { message: "delivery unavailable", retries: 2, enabled: false },
	},
	null,
	0,
]);
assert.equal(original.apiKey, credential);
assert.equal(input[1], original);
console.log("Packed redaction consumer passed");
