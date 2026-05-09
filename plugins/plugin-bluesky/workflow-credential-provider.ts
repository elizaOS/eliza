import { type IAgentRuntime, Service } from "@elizaos/core";

// Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = "workflow_credential_provider";
type CredentialProviderResult =
	| { status: "credential_data"; data: Record<string, unknown> }
	| { status: "needs_auth"; authUrl: string }
	| null;

// Bluesky (AT Protocol) uses app password credentials. No dedicated workflow node;
// use HTTP Request node. The runtime supplies handle + app password; workflows call
// com.atproto.server.createSession to get JWT.
const SUPPORTED = ["httpHeaderAuth"];

export class BlueskyWorkflowCredentialProvider extends Service {
	static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
	override capabilityDescription =
		"Supplies Bluesky credentials to the workflow plugin.";

	static async start(
		runtime: IAgentRuntime,
	): Promise<BlueskyWorkflowCredentialProvider> {
		return new BlueskyWorkflowCredentialProvider(runtime);
	}

	async stop(): Promise<void> {}

	async resolve(
		_userId: string,
		credType: string,
	): Promise<CredentialProviderResult> {
		if (credType !== "httpHeaderAuth") return null;
		const handle = this.runtime.getSetting("BLUESKY_HANDLE") as
			| string
			| undefined;
		const password = this.runtime.getSetting("BLUESKY_PASSWORD") as
			| string
			| undefined;
		if (!handle?.trim() || !password?.trim()) return null;
		return {
			status: "credential_data",
			data: {
				name: "X-Bluesky-Handle",
				value: handle.trim(),
				appPassword: password.trim(),
			},
		};
	}

	checkCredentialTypes(credTypes: string[]): {
		supported: string[];
		unsupported: string[];
	} {
		return {
			supported: credTypes.filter((t) => SUPPORTED.includes(t)),
			unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
		};
	}
}
