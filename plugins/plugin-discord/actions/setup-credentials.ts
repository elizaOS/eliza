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
const presets = new Map<string, CredentialPreset>();

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
			const response = await fetch("https://api.github.com/user", {
				headers: {
					Authorization: `Bearer ${credentials.token}`,
					Accept: "application/vnd.github+json",
				},
			});
			if (!response.ok) {
				return {
					valid: false,
					error: `GitHub returned ${response.status}`,
				};
			}
			const data = (await response.json()) as { login?: string };
			return {
				valid: true,
				identity: data.login ? `@${data.login}` : "verified",
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
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
			const response = await fetch("https://api.vercel.com/v9/projects", {
				headers: { Authorization: `Bearer ${credentials.token}` },
			});
			if (!response.ok) {
				return {
					valid: false,
					error: `Vercel returned ${response.status}`,
				};
			}
			const data = (await response.json()) as {
				projects?: Array<{ name: string }>;
			};
			return {
				valid: true,
				identity: `${data.projects?.length ?? 0} project(s) accessible`,
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
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
			const response = await fetch(
				"https://api.cloudflare.com/client/v4/zones",
				{
					headers: {
						"X-Auth-Key": credentials.apiKey,
						"X-Auth-Email": credentials.email,
					},
				},
			);
			if (!response.ok) {
				return {
					valid: false,
					error: `Cloudflare returned ${response.status}`,
				};
			}
			const data = (await response.json()) as {
				result?: Array<{ name: string }>;
			};
			return {
				valid: true,
				identity:
					data.result && data.result.length > 0
						? `zones: ${data.result.map((zone) => zone.name).join(", ")}`
						: "verified",
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
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
			// @duplicate-component-audit-allow: credential probe validates the key; response content is ignored.
			const response = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"x-api-key": credentials.apiKey,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "claude-3-5-haiku-20241022",
					max_tokens: 1,
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			if (response.ok || response.status === 429) {
				return { valid: true, identity: "key verified" };
			}
			return {
				valid: false,
				error: `Anthropic returned ${response.status}`,
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
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
			const response = await fetch("https://api.openai.com/v1/models", {
				headers: { Authorization: `Bearer ${credentials.apiKey}` },
			});
			if (response.ok || response.status === 429) {
				return { valid: true, identity: "key verified" };
			}
			return {
				valid: false,
				error: `OpenAI returned ${response.status}`,
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
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
			const response = await fetch("https://rest.fal.run/fal-ai/fast-sdxl", {
				method: "POST",
				headers: {
					Authorization: `Key ${credentials.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					prompt: "test",
					image_size: { width: 64, height: 64 },
					num_images: 1,
				}),
			});
			if (response.ok || response.status === 422 || response.status === 429) {
				return { valid: true, identity: "key verified" };
			}
			return {
				valid: false,
				error: `fal.ai returned ${response.status}`,
			};
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
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
		return null;
	}
}
