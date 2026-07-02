import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import {
	type EntitySpan,
	GazetteerEntityRecognizer,
} from "./entity-recognizer";
import { PseudonymSession } from "./pii-pseudonymizer";

const out: string[] = [];
const log = (...a: unknown[]) =>
	out.push(
		a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "),
	);

describe("probe3", () => {
	it("runs", async () => {
		// CASE-LEAK: learn "Bob" from prompt, but substitute a DIFFERENT text where the name appears uppercase.
		// In runtime, learn() runs on assembled prompt, substitute on same/other params. If a param has "BOB" but prompt had "Bob".
		{
			const s = new PseudonymSession({
				salt: "x",
				recognizer: new GazetteerEntityRecognizer([
					{ kind: "person", value: "Bob" },
				]),
			});
			await s.learn("Contact Bob about it"); // learns surface "Bob"
			const swapped = s.substituteText("Email BOB and bob and Bob now");
			log(
				"[CASE-LEAK] entry",
				s.entries.map((e) => e.value),
				"swapped",
				swapped,
			);
			log(
				"[CASE-LEAK] BOB-leaked",
				/\bBOB\b/.test(swapped),
				"bob-leaked",
				/\bbob\b/.test(swapped),
			);
		}
		// UNICODE-MID corruption: real value substituted inside an unrelated accented word -> real word Anaïs destroyed
		{
			const s = new PseudonymSession({
				salt: "x",
				recognizer: new GazetteerEntityRecognizer([
					{ kind: "person", value: "Ana" },
				]),
			});
			const text = "Anaïs Nin wrote to Ana";
			await s.learn(text);
			const swapped = s.substituteText(text);
			log(
				"[UNI-MID] swapped",
				swapped,
				"'Anaïs'-intact",
				swapped.includes("Anaïs"),
				"restore",
				s.restoreText(swapped),
				"restore-eq",
				s.restoreText(swapped) === text,
			);
		}
		// Same but where restore FAILS: surrogate ending letter glued to ï, restore boundary breaks?
		// Try value "Lena" (a surrogate FIRST_NAME) appearing inside "Lenaïd"
		{
			const s = new PseudonymSession({
				salt: "x",
				recognizer: new GazetteerEntityRecognizer([
					{ kind: "person", value: "Bo" },
				]),
			});
			const text = "Bornïte and Bo"; // "Bo" inside "Bornïte"? no, 'r' is a word char after Bo -> boundary blocks. good control.
			await s.learn(text);
			const swapped = s.substituteText(text);
			log(
				"[UNI-CTRL] swapped",
				swapped,
				"restore-eq",
				s.restoreText(swapped) === text,
				"size",
				s.size,
			);
		}
		// TRUE 512-exhaustion for 'location' via corpus poisoning of ALL 20 cities + all fallbacks?
		// Actually corpus poisoning only blocks corpus.includes. mint varies by attempt seed -> cycles pool.
		// To exhaust: make usedSurrogatesLower contain all 20 cities. Learn 20 distinct locations first (fills pool via fallback),
		// then the 21st must fallback. Confirm 21st surrogate is fallback-shaped and unique + restores.
		{
			const s = new PseudonymSession({ salt: "exh" });
			const vals = Array.from({ length: 21 }, (_, i) => `Loc_${i}`);
			const doc = vals.join(" ");
			s.learnSpans(
				doc,
				vals.map((v): EntitySpan => ({ kind: "location", value: v })),
			);
			const surrs = s.entries.map((e) => e.surrogate);
			const swapped = s.substituteText(doc);
			log(
				"[EXH-512] size",
				s.size,
				"distinct",
				new Set(surrs.map((x) => x.toLowerCase())).size,
				"restore-eq",
				s.restoreText(swapped) === doc,
			);
			// any surrogate NOT a bare city (contains a space+base36 tail) => fallback used
			log(
				"[EXH-512] fallbacks",
				surrs.filter((x) => x.split(" ").length > 1).length,
			);
		}
		// Does substituteText leak a real value when its surrogate is a SUBSTRING relationship of another surrogate? already covered by longest-first.
		// IDEMPOTENCY when a surrogate token equals another entry's real value AND appears standalone (multi-call chain restore direction)
		{
			const s = new PseudonymSession({ salt: "idem" });
			s.learnSpans("Priya", [{ kind: "person", value: "Priya" }]);
			const firstEntry = s.entries[0];
			if (!firstEntry) throw new Error("expected pseudonym entry");
			const surr = firstEntry.surrogate;
			// now a person literally named like the surrogate arrives
			s.learnSpans(surr, [{ kind: "person", value: surr }]);
			const doc = `Priya | ${surr}`;
			const sw1 = s.substituteText(doc);
			const sw2 = s.substituteText(sw1);
			log(
				"[IDEM-CHAIN] idempotent",
				sw1 === sw2,
				"restore-eq",
				s.restoreText(sw1) === doc,
				"sw1",
				sw1,
			);
		}
		writeFileSync(
			"/private/tmp/claude-501/-Users-shawwalters-eliza-workspace-milady-eliza/6d6de187-237a-4fc9-9689-34ed10a5d6e7/scratchpad/probe-out3.txt",
			out.join("\n"),
		);
	});
});
