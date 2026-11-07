/**
 * `membershipVersion` is `JSON.stringify(canonicalParticipants(...))`: the
 * participant order is persisted on every attested audience and copied into
 * scheduled-task delivery bindings, where another process compares it by
 * string equality at dispatch time. That order must be code-unit order:
 * ICU collation (`localeCompare`) ranks "aa…" after "b…" under Danish
 * rules, so a locale-ordered version differs between hosts for the
 * identical audience.
 *
 * Bun ignores `LC_ALL`, so the locale cases run in Node child processes
 * (the repo's pinned runtime), which honor it. Each child imports a bundle
 * of this module's TypeScript source (built with `bun build`, the same
 * bundling the module graph needs) and calls the real exported attestor
 * with a stub runtime.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const OWNER = "aa000000-0000-4000-8000-000000000001";
const AGENT = "b0000000-0000-4000-8000-000000000002";
const ROOM = "cc000000-0000-4000-8000-000000000003";

let bundleDir: string;
let bundleUrl: string;

beforeAll(() => {
	bundleDir = mkdtempSync(join(tmpdir(), "trusted-delivery-audience-"));
	const entry = join(
		import.meta.dirname,
		"..",
		"src",
		"security",
		"trusted-delivery-audience.ts",
	);
	const outfile = join(bundleDir, "audience.bundle.mjs");
	execFileSync(
		"bun",
		["build", entry, "--target=node", "--format=esm", "--outfile", outfile],
		{ encoding: "utf8", timeout: 120_000 },
	);
	bundleUrl = pathToFileURL(outfile).href;
}, 180_000);

afterAll(() => {
	if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

type MintResult = {
	collation: string[];
	participants: string[];
	membershipVersion: string;
};

function mintUnderLocale(locale: string): MintResult {
	const script = [
		`import { attestDeliveryAudienceFromCanonicalRoom } from ${JSON.stringify(bundleUrl)};`,
		`const OWNER = ${JSON.stringify(OWNER)};`,
		`const AGENT = ${JSON.stringify(AGENT)};`,
		`const ROOM = ${JSON.stringify(ROOM)};`,
		"const runtime = {",
		"  agentId: AGENT,",
		'  getSetting: (key) => (key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : null),',
		'  getRoom: async (id) => ({ id, type: "DM" }),',
		"  getParticipantsForRoom: async () => [AGENT, OWNER],",
		"  getEntityById: async () => null,",
		"  reportError: () => {},",
		"};",
		"const message = {",
		'  id: "dd000000-0000-4000-8000-000000000004",',
		"  entityId: OWNER,",
		"  roomId: ROOM,",
		'  content: { text: "hi" },',
		"};",
		"const audience = await attestDeliveryAudienceFromCanonicalRoom(runtime, message, { nowMs: 1000 });",
		"console.log(JSON.stringify({",
		"  collation: [OWNER, AGENT].sort((a, b) => a.localeCompare(b)),",
		"  participants: audience.participantEntityIds,",
		"  membershipVersion: audience.membershipVersion,",
		"}));",
	].join("\n");
	const result = spawnSync("node", ["--input-type=module", "-e", script], {
		encoding: "utf8",
		env: { ...process.env, LANG: locale, LC_ALL: locale },
		timeout: 30_000,
	});
	if (result.status !== 0) {
		throw new Error(
			`node child (${locale}) failed: ${result.stderr || String(result.error)}`,
		);
	}
	return JSON.parse(result.stdout.trim()) as MintResult;
}

describe("trusted-delivery audience membershipVersion across host locales", () => {
	it("mints the same membershipVersion under en_US and da_DK", () => {
		const enUs = mintUnderLocale("en_US.UTF-8");
		const daDk = mintUnderLocale("da_DK.UTF-8");
		// Sanity: the two child locales really do collate this pair in
		// opposite orders, so identical output cannot be a locale no-op.
		expect(enUs.collation).toEqual([OWNER, AGENT]);
		expect(daDk.collation).toEqual([AGENT, OWNER]);
		// Code-unit order (aa… < b0…) is the order en_US minted before this
		// change, so versions already stored under en_US stay valid.
		expect(enUs.participants).toEqual([OWNER, AGENT]);
		expect(enUs.membershipVersion).toBe(JSON.stringify([OWNER, AGENT]));
		expect(daDk.participants).toEqual(enUs.participants);
		expect(daDk.membershipVersion).toBe(enUs.membershipVersion);
	}, 60_000);
});
