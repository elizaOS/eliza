/**
 * Subscription-auth extension point.
 *
 * A model vendor's subscription product (its first-party CLI login, the
 * credential-store key, the surfaces where a login can be discovered) is a
 * property of the vendor, not of the host. This interface lets the plugin that
 * owns a vendor describe that product so the host `auth/` layer can stay
 * generic: the host drains the registry to discover and report subscription
 * credentials and never branches on a vendor id. Host `auth/` keeps only the
 * generic account store, credential storage, and refresh mutex.
 *
 * @module features/subscription-auth
 */

/**
 * A subscription credential discovered outside eliza's own account store — a
 * first-party CLI login blob (e.g. `~/.codex/auth.json`), a tool on `PATH`, or
 * another unmanaged provider surface. It is surfaced as a read-only row in the
 * subscription status list: it has no on-disk account file and cannot be
 * deleted through the account store.
 */
export interface DiscoveredSubscriptionCredential {
	/** Stable synthetic account id for the row, e.g. `"codex-cli"`. */
	accountId: string;
	/** User-facing label, e.g. `"Codex CLI"`. */
	label: string;
	/**
	 * Provenance tag — a `SubscriptionCredentialSource` value (e.g. `"codex-cli"`,
	 * `"gemini-cli"`, `"unavailable"`, or `null`). Typed as `string | null` here
	 * so `@elizaos/core` need not depend on the host's credential-source union.
	 */
	source: string | null;
	/** True when the surface is present/usable. */
	configured: boolean;
	/** True when the discovered credential is currently valid. */
	valid: boolean;
	/** Epoch-ms expiry, or `null` when the surface manages its own lifetime. */
	expiresAt: number | null;
}

/**
 * Describes a model vendor's subscription product to the host. Registered by
 * the model-provider plugin that owns the vendor (or, transitionally, by a
 * host built-in). The host reads these fields instead of hard-coding the
 * vendor.
 */
export interface SubscriptionAuthProvider {
	/** Credential-store provider id, e.g. `"openai-codex"`. */
	readonly id: string;
	/**
	 * Discover subscription credentials this vendor manages outside eliza's
	 * account store — CLI login blobs, tools on `PATH`, unavailable-provider
	 * notices. Pure and read-only (it is called on every status poll). Returns
	 * the row(s) to surface, or `null` / `[]` when the vendor manages nothing
	 * discoverable right now.
	 */
	detectExternalCredentials?: () =>
		| DiscoveredSubscriptionCredential
		| DiscoveredSubscriptionCredential[]
		| null;
}
