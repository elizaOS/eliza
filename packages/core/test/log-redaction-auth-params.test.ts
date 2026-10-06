import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { redactSensitiveLogText } from "../src/security/log-redaction.ts";

describe("log redaction auth-param lists", () => {
	it("preserves the diagnostic affixes of long masked parameter lists", () => {
		expect(
			redactSensitiveLogText(
				'Authorization: Digest username="u", realm="r",  response=abc',
			),
		).toBe("Authorization: Digest userna…=abc");
	});

	it("finishes malformed comma-heavy input in a bounded Node subprocess", () => {
		const source = new URL("../src/security/log-redaction.ts", import.meta.url)
			.href;
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`const { redactSensitiveLogText } = await import(${JSON.stringify(source)});
for (const count of [30, 300, 3000]) {
  redactSensitiveLogText("Authorization: Custom a=b" + " ,".repeat(count) + "!");
}
console.log("completed");`,
			],
			{ encoding: "utf8", timeout: 2000 },
		);
		expect(result.error?.message).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("completed");
	});

	it.each([
		'a="u", b="r"',
		"a=b , , c=d",
		"a=b,,c=d,",
		", a=b",
		'a = b ,\tc = "d e"',
	])("preserves masking with irregular separators: %s", (remainder) => {
		const output = redactSensitiveLogText(`Authorization: Digest ${remainder}`);
		expect(output).toContain("Authorization: Digest ");
		expect(output).not.toContain(remainder);
		expect(output).toBe("Authorization: Digest ***");
	});
});
