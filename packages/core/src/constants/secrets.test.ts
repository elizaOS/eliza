/**
 * Secret-key alias resolution maps legacy/provider env names onto canonical
 * keys. Resolution must be exact (a wrong canonical key reads the wrong
 * credential), and lookups must round-trip alias ⇄ canonical. Asserted against
 * the live maps so the test tracks the data rather than hardcoding it.
 */
import { describe, expect, it } from "vitest";
import {
	CANONICAL_SECRET_KEYS,
	CHANNEL_SECRETS,
	getAliasesForKey,
	getAllSecretsForChannel,
	getProviderForApiKey,
	getRequiredSecretsForChannel,
	isCanonicalSecretKey,
	isSecretKeyAlias,
	MODEL_PROVIDER_SECRETS,
	resolveSecretKeyAlias,
	SECRET_KEY_ALIASES,
} from "./secrets.ts";

const [firstAlias, canonicalForFirstAlias] =
	Object.entries(SECRET_KEY_ALIASES)[0];
const [firstProvider, firstProviderKey] = Object.entries(
	MODEL_PROVIDER_SECRETS,
)[0];
const [firstChannel, firstChannelSecrets] = Object.entries(CHANNEL_SECRETS)[0];

describe("alias resolution", () => {
	it("resolves a known alias and passes unknown keys through", () => {
		expect(resolveSecretKeyAlias(firstAlias)).toBe(canonicalForFirstAlias);
		expect(resolveSecretKeyAlias("DEFINITELY_NOT_AN_ALIAS_XYZ")).toBe(
			"DEFINITELY_NOT_AN_ALIAS_XYZ",
		);
		expect(isSecretKeyAlias(firstAlias)).toBe(true);
		expect(isSecretKeyAlias("DEFINITELY_NOT_AN_ALIAS_XYZ")).toBe(false);
	});

	it("getAliasesForKey round-trips back to the alias", () => {
		expect(getAliasesForKey(canonicalForFirstAlias)).toContain(firstAlias);
		expect(getAliasesForKey("NOT_A_CANONICAL_KEY_XYZ")).toEqual([]);
	});
});

describe("isCanonicalSecretKey", () => {
	it("recognizes canonical keys only", () => {
		expect(isCanonicalSecretKey(CANONICAL_SECRET_KEYS[0])).toBe(true);
		expect(isCanonicalSecretKey("NOT_CANONICAL_XYZ")).toBe(false);
	});
});

describe("getProviderForApiKey", () => {
	it("maps an API-key env name back to its provider, else null", () => {
		expect(getProviderForApiKey(firstProviderKey)).toBe(firstProvider);
		expect(getProviderForApiKey("UNMAPPED_KEY_XYZ")).toBeNull();
	});
});

describe("channel secrets", () => {
	it("returns required/optional secrets, empty for unknown channels", () => {
		expect(getRequiredSecretsForChannel(firstChannel)).toEqual(
			firstChannelSecrets,
		);
		expect(getRequiredSecretsForChannel("no-such-channel")).toEqual([]);
		expect(getAllSecretsForChannel(firstChannel).required).toEqual(
			firstChannelSecrets,
		);
		expect(getAllSecretsForChannel("no-such-channel")).toEqual({
			required: [],
			optional: [],
		});
	});
});
