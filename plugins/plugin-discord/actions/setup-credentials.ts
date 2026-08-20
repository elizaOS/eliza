/**
 * Credential preset definitions and loader for the connector `/setup` flow.
 * Describes the fields each credential preset requires and reads their values
 * from disk.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
const CREDENTIAL_PROBE_TIMEOUT_MS = 15_000;
const CREDENTIAL_PROBE_MAX_BODY_BYTES = 64 * 1024;
const CREDENTIAL_VALUE_MAX_LENGTH = 16 * 1024;
const presets = new Map<string, CredentialPreset>();

class CredentialProbeError extends Error {
	constructor(readonly kind: "timeout" | "response" | "network") {
		super(kind);
		this.name = "CredentialProbeError";
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

async function startBodyCancellation(
	stream:
		| ReadableStream<Uint8Array>
		| ReadableStreamDefaultReader<Uint8Array>
		| null,
	reason?: unknown,
): Promise<void> {
	if (!stream) return;
	// Starting cancellation is sufficient for this boundary. A provider stream's
	// teardown promise must not extend the probe deadline, while Promise.race still
	// observes a later cancellation rejection.
	await Promise.race([stream.cancel(reason), Promise.resolve()]);
}

async function readBodyChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
	if (signal.aborted) throw new CredentialProbeError("timeout");
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
	const declaredLength = parseContentLength(
		response.headers.get("content-length"),
	);
	if (
		declaredLength !== null &&
		declaredLength > CREDENTIAL_PROBE_MAX_BODY_BYTES
	) {
		await startBodyCancellation(response.body, "credential response too large");
		throw new CredentialProbeError("response");
	}

	if (!response.body) return new Uint8Array();
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
		await startBodyCancellation(reader, error);
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
	return body;
}

async function readProbeJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	if (!isJsonContentType(response.headers.get("content-type"))) {
		await startBodyCancellation(
			response.body,
			"invalid credential response type",
		);
		throw new CredentialProbeError("response");
	}
	const bytes = await readBoundedBody(response, signal);
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return JSON.parse(text) as unknown;
	} catch {
		// error-policy:J3 malformed provider JSON is an explicit invalid response.
		throw new CredentialProbeError("response");
	}
}

async function credentialProbe(
	url: string,
	init: RequestInit,
): Promise<{ response: Response; signal: AbortSignal }> {
	const signal = AbortSignal.timeout(CREDENTIAL_PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			...init,
			redirect: "error",
			signal,
		});
		return { response, signal };
	} catch {
		// error-policy:J1 network and timeout failures become stable probe errors.
		if (signal.aborted) throw new CredentialProbeError("timeout");
		throw new CredentialProbeError("network");
	}
}

async function discardProbeBody(
	response: Response,
	_signal: AbortSignal,
): Promise<void> {
	await startBodyCancellation(
		response.body,
		"credential response not consumed",
	);
}

function invalidProbeResult(
	service: string,
	error: unknown,
): { valid: false; error: string } {
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
		throw new CredentialProbeError("response");
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
				await discardProbeBody(response, signal);
				return {
					valid: false,
					error: `GitHub returned ${response.status}`,
				};
			}
			const data = await readProbeJson(response, signal);
			if (
				!isRecord(data) ||
				typeof data.login !== "string" ||
				!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(data.login)
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
				await discardProbeBody(response, signal);
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
				await discardProbeBody(response, signal);
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
				"https://api.anthropic.com/v1/messages",
				{
					method: "POST",
					headers: {
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: "claude-3-5-haiku-20241022",
						max_tokens: 1,
						messages: [{ role: "user", content: "hi" }],
					}),
				},
			);
			if (response.ok) {
				await discardProbeBody(response, signal);
				return { valid: true, identity: "key verified" };
			}
			await discardProbeBody(response, signal);
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
				await discardProbeBody(response, signal);
				return { valid: true, identity: "key verified" };
			}
			await discardProbeBody(response, signal);
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
				"https://rest.fal.run/fal-ai/fast-sdxl",
				{
					method: "POST",
					headers: {
						Authorization: `Key ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						prompt: "test",
						image_size: { width: 64, height: 64 },
						num_images: 1,
					}),
				},
			);
			if (response.ok) {
				await discardProbeBody(response, signal);
				return { valid: true, identity: "key verified" };
			}
			await discardProbeBody(response, signal);
			return {
				valid: false,
				error: `fal.ai returned ${response.status}`,
			};
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
