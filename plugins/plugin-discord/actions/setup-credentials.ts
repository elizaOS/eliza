/**
 * Credential preset definitions and loader for the connector `/setup` flow.
 * Describes the fields each credential preset requires and reads their values
 * from disk.
 *
 * Preset `validate` hooks probe third-party APIs with attacker-influenced
 * responses, so every probe is bounded and fails closed: a shared deadline
 * covers the request and every body read, redirects are refused rather than
 * followed, bodies are capped and must be JSON matching the provider's success
 * schema, and unconsumed bodies are cancelled. Failures are translated into a
 * fixed set of messages that never echo transport detail or credential text,
 * and input rejected before a request leaves the process is reported as local
 * input error rather than as provider misbehaviour.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ElizaError, logger } from "@elizaos/core";

export interface CredentialPreset {
	name: string;
	displayName: string;
	fields: CredentialField[];
	helpUrl: string;
	helpText: string;
	validate: (
		credentials: Record<string, string>,
	) => Promise<{ valid: boolean; identity?: string; error?: string }>;
}

export interface CredentialField {
	key: string;
	label: string;
	secret: boolean;
}

const SAFE_PRESET_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const SETUP_CREDENTIAL_FETCH_TIMEOUT_MS = 15_000;
const CREDENTIAL_PROBE_MAX_BODY_BYTES = 64 * 1024;
const CREDENTIAL_VALUE_MAX_LENGTH = 16 * 1024;
const presets = new Map<string, CredentialPreset>();

class CredentialProbeError extends ElizaError {
	constructor(readonly kind: "timeout" | "response" | "network") {
		super("Credential validation probe failed.", {
			code:
				kind === "timeout"
					? "CREDENTIAL_PROBE_TIMEOUT"
					: kind === "response"
						? "CREDENTIAL_PROBE_RESPONSE_INVALID"
						: "CREDENTIAL_PROBE_NETWORK_FAILED",
			context: { kind },
			severity: kind === "response" ? "fatal" : "ephemeral",
		});
	}
}

/**
 * Raised when supplied credential input is rejected locally, before any
 * request leaves the process. Kept distinct from CredentialProbeError so the
 * user-facing message never blames the provider for input that was never sent.
 */
class CredentialInputError extends ElizaError {
	constructor(readonly field: string) {
		super("Credential input rejected before probing the provider.", {
			code: "CREDENTIAL_INPUT_INVALID",
			context: { field },
			severity: "fatal",
		});
	}
}

function isJsonContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
	return (
		mediaType === "application/json" || mediaType?.endsWith("+json") === true
	);
}

function parseContentLength(value: string | null): number | null {
	if (value === null) return null;
	if (!/^\d+$/.test(value)) throw new CredentialProbeError("response");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new CredentialProbeError("response");
	return parsed;
}

function cancelProbeBody(
	stream:
		| ReadableStream<Uint8Array>
		| ReadableStreamDefaultReader<Uint8Array>
		| null,
	reason?: unknown,
): void {
	if (!stream) return;
	try {
		// error-policy:J6 provider-stream teardown is best effort and must not
		// extend the probe deadline; its rejection is observed and safely logged.
		void stream.cancel(reason).catch(() => {
			logger.debug(
				"[DiscordCredentialProbe] Failed to cancel provider response body",
			);
		});
	} catch {
		// error-policy:J6 synchronous provider-stream teardown failure is safe to ignore.
		logger.debug(
			"[DiscordCredentialProbe] Failed to cancel provider response body",
		);
	}
}

function throwIfProbeTimedOut(signal: AbortSignal): void {
	if (signal.aborted) throw new CredentialProbeError("timeout");
}

async function readBodyChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
	throwIfProbeTimedOut(signal);
	return await new Promise((resolve, reject) => {
		const onAbort = () => reject(new CredentialProbeError("timeout"));
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function readBoundedBody(
	response: Response,
	signal: AbortSignal,
): Promise<Uint8Array> {
	throwIfProbeTimedOut(signal);
	const declaredLength = parseContentLength(
		response.headers.get("content-length"),
	);
	if (
		declaredLength !== null &&
		declaredLength > CREDENTIAL_PROBE_MAX_BODY_BYTES
	) {
		cancelProbeBody(response.body, "credential response too large");
		throw new CredentialProbeError("response");
	}

	if (!response.body) {
		throwIfProbeTimedOut(signal);
		return new Uint8Array();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			const chunk = await readBodyChunk(reader, signal);
			if (chunk.done) break;
			if (!chunk.value) throw new CredentialProbeError("response");
			received += chunk.value.byteLength;
			if (received > CREDENTIAL_PROBE_MAX_BODY_BYTES) {
				throw new CredentialProbeError("response");
			}
			chunks.push(chunk.value);
		}
	} catch (error) {
		// error-policy:J2 cancel the bounded reader before preserving its typed failure.
		cancelProbeBody(reader, error);
		throw error;
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	throwIfProbeTimedOut(signal);
	return body;
}

async function readProbeJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	if (!isJsonContentType(response.headers.get("content-type"))) {
		cancelProbeBody(response.body, "invalid credential response type");
		throw new CredentialProbeError("response");
	}
	const bytes = await readBoundedBody(response, signal);
	let parsed: unknown;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		parsed = JSON.parse(text) as unknown;
	} catch {
		// error-policy:J3 malformed provider JSON is an explicit invalid response.
		throw new CredentialProbeError("response");
	}
	// Keep the deadline check outside the parse catch so a timeout that races a
	// valid payload retains its typed timeout identity.
	throwIfProbeTimedOut(signal);
	return parsed;
}

async function credentialProbe(
	url: string,
	init: RequestInit,
): Promise<{ response: Response; signal: AbortSignal }> {
	const signal = AbortSignal.timeout(SETUP_CREDENTIAL_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			...init,
			redirect: "error",
			signal,
		});
		if (signal.aborted) {
			cancelProbeBody(response.body, "credential probe timed out");
			throw new CredentialProbeError("timeout");
		}
		return { response, signal };
	} catch {
		// error-policy:J1 network and timeout failures become stable probe errors.
		if (signal.aborted) throw new CredentialProbeError("timeout");
		throw new CredentialProbeError("network");
	}
}

function discardProbeBody(response: Response, signal: AbortSignal): void {
	throwIfProbeTimedOut(signal);
	cancelProbeBody(response.body, "credential response not consumed");
	throwIfProbeTimedOut(signal);
}

function invalidProbeResult(
	service: string,
	error: unknown,
): { valid: false; error: string } {
	if (error instanceof CredentialInputError) {
		return {
			valid: false,
			error: `Invalid ${error.field} value; provide a non-empty single-line value`,
		};
	}
	const kind = error instanceof CredentialProbeError ? error.kind : "network";
	return {
		valid: false,
		error:
			kind === "timeout"
				? `${service} credential validation timed out`
				: kind === "response"
					? `${service} returned an invalid response`
					: `Unable to reach ${service} credential service`,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCredential(
	credentials: Record<string, string>,
	key: string,
	maxLength = CREDENTIAL_VALUE_MAX_LENGTH,
): string {
	const value = credentials[key];
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maxLength ||
		/[\r\n\0]/.test(value)
	) {
		throw new CredentialInputError(key);
	}
	return value;
}

function getCredentialsDir(): string {
	const configured = process.env.CREDENTIALS_DIR?.trim();
	if (configured) {
		return configured;
	}

	const home =
		(typeof os.homedir === "function" ? os.homedir() : "") ||
		process.env.HOME ||
		process.env.USERPROFILE;
	return home
		? path.join(home, ".credentials")
		: path.join(process.cwd(), ".credentials");
}

export function registerPreset(preset: CredentialPreset): void {
	const normalizedName = preset.name.trim().toLowerCase();
	if (!SAFE_PRESET_NAME_RE.test(normalizedName)) {
		throw new Error(
			`Invalid credential preset name "${preset.name}". Only letters, numbers, underscores, and hyphens are allowed.`,
		);
	}
	presets.set(normalizedName, { ...preset, name: normalizedName });
}

export function getPreset(name: string): CredentialPreset | undefined {
	return presets.get(name.toLowerCase());
}

export function listPresets(): string[] {
	return [...presets.keys()];
}

registerPreset({
	name: "github",
	displayName: "GitHub",
	fields: [{ key: "token", label: "Personal Access Token", secret: true }],
	helpUrl: "https://github.com/settings/tokens",
	helpText:
		"Create a fine-grained PAT at the link above. Give it the repository permissions you need.",
	async validate(credentials) {
		try {
			const token = requireCredential(credentials, "token");
			const { response, signal } = await credentialProbe(
				"https://api.github.com/user",
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github+json",
					},
				},
			);
			if (!response.ok) {
				discardProbeBody(response, signal);
				return {
					valid: false,
					error: `GitHub returned ${response.status}`,
				};
			}
			const data = await readProbeJson(response, signal);
			// The character class includes underscores because Enterprise Managed
			// User logins (for example "mona_acme") are valid GitHub identities.
			if (
				!isRecord(data) ||
				typeof data.login !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(data.login)
			) {
				throw new CredentialProbeError("response");
			}
			return {
				valid: true,
				identity: `@${data.login}`,
			};
		} catch (error) {
			// error-policy:J1 credential probes expose only bounded, secret-free failures.
			return invalidProbeResult("GitHub", error);
		}
	},
});

registerPreset({
	name: "vercel",
	displayName: "Vercel",
	fields: [{ key: "token", label: "API Token", secret: true }],
	helpUrl: "https://vercel.com/account/tokens",
	helpText: "Create a token at the link above. Full Account scope works best.",
	async validate(credentials) {
		try {
			const token = requireCredential(credentials, "token");
			const { response, signal } = await credentialProbe(
				"https://api.vercel.com/v9/projects",
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			if (!response.ok) {
				discardProbeBody(response, signal);
				return {
					valid: false,
					error: `Vercel returned ${response.status}`,
				};
			}
			const data = await readProbeJson(response, signal);
			if (!isRecord(data) || !Array.isArray(data.projects)) {
				throw new CredentialProbeError("response");
			}
			return {
				valid: true,
				identity: `${data.projects.length} project(s) returned by probe`,
			};
		} catch (error) {
			// error-policy:J1 credential probes expose only bounded, secret-free failures.
			return invalidProbeResult("Vercel", error);
		}
	},
});

registerPreset({
	name: "cloudflare",
	displayName: "Cloudflare",
	fields: [
		{ key: "apiKey", label: "Global API Key", secret: true },
		{ key: "email", label: "Account Email", secret: false },
	],
	helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
	helpText:
		'Go to Cloudflare > Profile > API Tokens > "Global API Key". You will also need your account email.',
	async validate(credentials) {
		try {
			const apiKey = requireCredential(credentials, "apiKey");
			const email = requireCredential(credentials, "email", 320);
			const { response, signal } = await credentialProbe(
				"https://api.cloudflare.com/client/v4/zones",
				{
					headers: {
						"X-Auth-Key": apiKey,
						"X-Auth-Email": email,
					},
				},
			);
			if (!response.ok) {
				discardProbeBody(response, signal);
				return {
					valid: false,
					error: `Cloudflare returned ${response.status}`,
				};
			}
			const data = await readProbeJson(response, signal);
			if (
				!isRecord(data) ||
				data.success !== true ||
				!Array.isArray(data.result)
			) {
				throw new CredentialProbeError("response");
			}
			return {
				valid: true,
				identity: `${data.result.length} zone(s) returned by probe`,
			};
		} catch (error) {
			// error-policy:J1 credential probes expose only bounded, secret-free failures.
			return invalidProbeResult("Cloudflare", error);
		}
	},
});

registerPreset({
	name: "anthropic",
	displayName: "Anthropic",
	fields: [{ key: "apiKey", label: "API Key", secret: true }],
	helpUrl: "https://console.anthropic.com/settings/keys",
	helpText: "Create an API key in the Anthropic console.",
	async validate(credentials) {
		try {
			const apiKey = requireCredential(credentials, "apiKey");
			// @duplicate-component-audit-allow: credential probe validates the key; response content is ignored.
			const { response, signal } = await credentialProbe(
				"https://api.anthropic.com/v1/models?limit=1",
				{
					headers: {
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
					},
				},
			);
			if (response.ok) {
				discardProbeBody(response, signal);
				return { valid: true, identity: "key verified" };
			}
			discardProbeBody(response, signal);
			return {
				valid: false,
				error: `Anthropic returned ${response.status}`,
			};
		} catch (error) {
			// error-policy:J1 credential probes expose only bounded, secret-free failures.
			return invalidProbeResult("Anthropic", error);
		}
	},
});

registerPreset({
	name: "openai",
	displayName: "OpenAI",
	fields: [{ key: "apiKey", label: "API Key", secret: true }],
	helpUrl: "https://platform.openai.com/api-keys",
	helpText: "Create an API key at the OpenAI platform link above.",
	async validate(credentials) {
		try {
			const apiKey = requireCredential(credentials, "apiKey");
			const { response, signal } = await credentialProbe(
				"https://api.openai.com/v1/models",
				{ headers: { Authorization: `Bearer ${apiKey}` } },
			);
			if (response.ok) {
				discardProbeBody(response, signal);
				return { valid: true, identity: "key verified" };
			}
			discardProbeBody(response, signal);
			return {
				valid: false,
				error: `OpenAI returned ${response.status}`,
			};
		} catch (error) {
			// error-policy:J1 credential probes expose only bounded, secret-free failures.
			return invalidProbeResult("OpenAI", error);
		}
	},
});

registerPreset({
	name: "fal",
	displayName: "fal.ai",
	fields: [{ key: "apiKey", label: "API Key", secret: true }],
	helpUrl: "https://fal.ai/dashboard/keys",
	helpText: "Generate an API key from your fal.ai dashboard.",
	async validate(credentials) {
		try {
			const apiKey = requireCredential(credentials, "apiKey");
			const { response, signal } = await credentialProbe(
				"https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai%2Fflux%2Fdev",
				{
					headers: {
						Authorization: `Key ${apiKey}`,
					},
				},
			);
			if (!response.ok) {
				discardProbeBody(response, signal);
				return {
					valid: false,
					error: `fal.ai returned ${response.status}`,
				};
			}
			// fal's authenticated Platform Pricing API is a read-only metadata
			// request, so validation cannot enqueue or bill model inference.
			const data = await readProbeJson(response, signal);
			if (
				!isRecord(data) ||
				!Array.isArray(data.prices) ||
				typeof data.has_more !== "boolean" ||
				!(data.next_cursor === null || typeof data.next_cursor === "string")
			) {
				throw new CredentialProbeError("response");
			}
			return { valid: true, identity: "key verified" };
		} catch (error) {
			// error-policy:J1 credential probes expose only bounded, secret-free failures.
			return invalidProbeResult("fal.ai", error);
		}
	},
});

registerPreset({
	name: "generic",
	displayName: "Custom Credential",
	fields: [
		{
			key: "envName",
			label: "environment variable name (for example MY_API_KEY)",
			secret: false,
		},
		{ key: "value", label: "value", secret: true },
	],
	helpUrl: "",
	helpText:
		"I'll store this as a generic credential. Give me the env var name and value.",
	async validate() {
		return { valid: true, identity: "stored (unvalidated)" };
	},
});

export function loadCredentials(
	service: string,
): Record<string, string> | null {
	const filePath = path.join(getCredentialsDir(), `${service}.json`);
	if (!fs.existsSync(filePath)) {
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
			string,
			string
		>;
	} catch {
		// error-policy:J3 malformed credential files are treated as absent input.
		return null;
	}
}
