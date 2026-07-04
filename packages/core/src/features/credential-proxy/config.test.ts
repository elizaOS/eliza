import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_PROXY_RAW_PAT_VARS,
	CredentialProxyStrictError,
	DEFAULT_CREDENTIAL_PROXY_ROUTES,
	resolveCredentialProxyConfig,
} from "./config.ts";

function fromMap(map: Record<string, string | undefined>) {
	return (key: string) => map[key];
}

describe("resolveCredentialProxyConfig", () => {
	it("is off (undefined) unless BOTH url and token are set", () => {
		expect(resolveCredentialProxyConfig(fromMap({}))).toBeUndefined();
		expect(
			resolveCredentialProxyConfig(
				fromMap({ ELIZA_CREDENTIAL_PROXY_URL: "https://p" }),
			),
		).toBeUndefined();
		expect(
			resolveCredentialProxyConfig(
				fromMap({ ELIZA_CREDENTIAL_PROXY_TOKEN: "t" }),
			),
		).toBeUndefined();
		// whitespace-only is treated as unset
		expect(
			resolveCredentialProxyConfig(
				fromMap({
					ELIZA_CREDENTIAL_PROXY_URL: "  ",
					ELIZA_CREDENTIAL_PROXY_TOKEN: "t",
				}),
			),
		).toBeUndefined();
	});

	it("resolves url/token/signingKey and defaults routes + non-strict", () => {
		const cfg = resolveCredentialProxyConfig(
			fromMap({
				ELIZA_CREDENTIAL_PROXY_URL: "https://proxy.internal/broker",
				ELIZA_CREDENTIAL_PROXY_TOKEN: "agent-handle",
				ELIZA_CREDENTIAL_PROXY_SIGNING_KEY: "hmac",
			}),
		);
		expect(cfg).toEqual({
			url: "https://proxy.internal/broker",
			token: "agent-handle",
			signingKey: "hmac",
			strict: false,
			routes: DEFAULT_CREDENTIAL_PROXY_ROUTES,
		});
	});

	it("honours strict truthy values", () => {
		const cfg = resolveCredentialProxyConfig(
			fromMap({
				ELIZA_CREDENTIAL_PROXY_URL: "https://p",
				ELIZA_CREDENTIAL_PROXY_TOKEN: "t",
				ELIZA_CREDENTIAL_PROXY_STRICT: "1",
			}),
		);
		expect(cfg?.strict).toBe(true);
	});

	it("parses a routes override and rejects malformed JSON (fail-closed)", () => {
		const cfg = resolveCredentialProxyConfig(
			fromMap({
				ELIZA_CREDENTIAL_PROXY_URL: "https://p",
				ELIZA_CREDENTIAL_PROXY_TOKEN: "t",
				ELIZA_CREDENTIAL_PROXY_ROUTES: JSON.stringify([
					{ host: "GitLab.com", methods: ["get"], pathPrefix: "/api/" },
				]),
			}),
		);
		expect(cfg?.routes).toEqual([
			{ host: "gitlab.com", methods: ["GET"], pathPrefix: "/api/" },
		]);

		expect(() =>
			resolveCredentialProxyConfig(
				fromMap({
					ELIZA_CREDENTIAL_PROXY_URL: "https://p",
					ELIZA_CREDENTIAL_PROXY_TOKEN: "t",
					ELIZA_CREDENTIAL_PROXY_ROUTES: "{ not an array }",
				}),
			),
		).toThrow();

		expect(() =>
			resolveCredentialProxyConfig(
				fromMap({
					ELIZA_CREDENTIAL_PROXY_URL: "https://p",
					ELIZA_CREDENTIAL_PROXY_TOKEN: "t",
					ELIZA_CREDENTIAL_PROXY_ROUTES: JSON.stringify([
						{ host: "x.com", methods: [], pathPrefix: "/" },
					]),
				}),
			),
		).toThrow(/methods/);
	});

	it("exposes the raw VCS PAT deny-list and a named strict error", () => {
		expect(CREDENTIAL_PROXY_RAW_PAT_VARS).toContain("GITHUB_TOKEN");
		expect(CREDENTIAL_PROXY_RAW_PAT_VARS).toContain("GH_TOKEN");
		const err = new CredentialProxyStrictError("GH_TOKEN");
		expect(err.offendingVar).toBe("GH_TOKEN");
		expect(err.message).toContain("GH_TOKEN");
	});
});
