import { describe, expect, it } from "vitest";
import { RegexEntityRecognizer } from "../src/security/entity-recognizer";
import { detectPii } from "../src/security/pii-detectors";
import { SecretSwapSession } from "../src/security/secret-swap";

/**
 * v613 (Pixel): a Maps card in chat history reached the planner as
 * `"longitude":-__ELIZA_CONTACT_<nonce>_34__`. The phone pattern reads
 * "122.4194093" as 122-419-4093. A coordinate is never a contact.
 */
const phones = (text: string) =>
	detectPii(text)
		.filter((match) => match.kind === "phone")
		.map((match) => match.value);

const CARD = [
	"[MAPSCARD]",
	JSON.stringify({
		kind: "directions",
		origin: { name: "Home", latitude: 37.7749295, longitude: -122.4194093 },
		destination: { latitude: 37.8043514, longitude: -122.2711639 },
		route: {
			coordinates: [
				[-122.4194093, 37.7749295],
				[-122.2711639, 37.8043514],
			],
		},
	}),
	"[/MAPSCARD]",
].join("\n");

describe("phone detection around map coordinates", () => {
	it("leaves every latitude and longitude in a Maps card alone", () => {
		expect(phones(CARD)).toEqual([]);
	});

	it("leaves coordinate values alone outside a card", () => {
		expect(phones('{"lat":37.7749295,"lng":-122.4194093}')).toEqual([]);
		expect(phones('{\\"longitude\\":-122.4194093}')).toEqual([]);
		expect(phones("longitude = 122.4194093")).toEqual([]);
		expect(phones("the pin is at 37.7749295, -122.4194093")).toEqual([]);
		expect(phones("the pin is at 122.4194093, 37.7749295")).toEqual([]);
		expect(phones("coordinates 122.4194093 for the pin")).toEqual([]);
	});

	it("still finds real phone numbers in prose, beside a card too", () => {
		expect(phones("call 415-555-0100 please")).toEqual(["415-555-0100"]);
		expect(phones("ring 415.555.0100 or (415) 555-0199")).toEqual([
			"415.555.0100",
			"(415) 555-0199",
		]);
		expect(phones(`${CARD}\nuser: call 415-555-0100`)).toEqual([
			"415-555-0100",
		]);
		// A phone written in a location sentence is still a phone.
		expect(phones("my location is home, call 415-555-0100")).toEqual([
			"415-555-0100",
		]);
	});

	it("never lets a literal, unclosed or truncated card marker hide a phone", () => {
		// A card cut short in history, then the owner's request.
		expect(
			phones(
				'[MAPSCARD]\n{"kind":"place","place":{"latitude":37.7749295,"longitude":-122.4194093\nuser: call 415-555-0100',
			),
		).toEqual(["415-555-0100"]);
		// The owner typing the marker word.
		expect(phones("I saw [MAPSCARD] somewhere. call 415-555-0100")).toEqual([
			"415-555-0100",
		]);
		expect(phones('[MAPSCARD] {"x":1} call 415-555-0100')).toEqual([
			"415-555-0100",
		]);
		// An unclosed marker before a later, complete card.
		expect(
			phones(
				'[MAPSCARD]\n{"a":1\nuser: call 415-555-0100\n[MAPSCARD]\n{}\n[/MAPSCARD]',
			),
		).toEqual(["415-555-0100"]);
		// A CRLF card still covers its own JSON line only.
		expect(
			phones(
				'[MAPSCARD]\r\n{"longitude":-122.4194093,"geoUri":"geo:37.7749295,-122.4194093"}\r\n[/MAPSCARD]\r\nuser: call 415-555-0100',
			),
		).toEqual(["415-555-0100"]);
	});

	it("never mints a contact reference for a coordinate", () => {
		const session = new SecretSwapSession();
		const prompt = session.substituteText(`${CARD}\nuser: call 415-555-0100`);
		expect(prompt).toContain('"longitude":-122.4194093');
		expect(prompt).toContain('"latitude":37.8043514');
		expect(prompt).not.toContain("415-555-0100");
		expect(session.entries).toHaveLength(1);
		expect(session.entries[0]).toMatchObject({
			kind: "phone",
			value: "415-555-0100",
		});
		expect(session.entries[0]?.placeholder).toMatch(/^__ELIZA_CONTACT_/);
	});

	it("swaps a structured payload's phone, never its coordinates", () => {
		const session = new SecretSwapSession();
		const swapped = session.substituteInValue({
			card: CARD,
			place: {
				phone: "415-555-0100",
				latitude: 37.7749295,
				longitude: -122.4194093,
			},
		});
		expect(swapped.card).toBe(CARD);
		expect(swapped.place.phone).toMatch(/^__ELIZA_CONTACT_/);
		expect(swapped.place.longitude).toBe(-122.4194093);
	});

	it("keeps the browser-safe recognizer copy in step", async () => {
		const recognizer = new RegexEntityRecognizer({ phone: true });
		const spans = await recognizer.recognize(
			`${CARD}\nuser: call 415-555-0100`,
		);
		expect(
			spans.filter((span) => span.kind === "phone").map((span) => span.value),
		).toEqual(["415-555-0100"]);
	});
});
