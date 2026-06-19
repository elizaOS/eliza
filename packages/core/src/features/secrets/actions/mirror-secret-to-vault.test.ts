import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { mirrorSecretToVaultHandler } from "./mirror-secret-to-vault";

interface VaultStub {
	calls: Array<{ key: string; value: string }>;
	setSecret: (key: string, value: string) => Promise<boolean>;
}

function createRuntime(opts: {
	secretValue?: string | null;
	vault?: VaultStub | null;
}) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "SECRETS") {
				return {
					get: async () => opts.secretValue ?? "sk-real",
				};
			}
			if (name === "STEWARD_VAULT") {
				return opts.vault ?? null;
			}
			return null;
		},
		getSetting: () => undefined,
		composeState: async () => ({}),
		dynamicPromptExecFromState: async () => ({}),
	};
}

function createMessage() {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "", channelType: ChannelType.DM },
	};
}

describe("SECRETS action=mirror", () => {
	test("mirrors the secret into the named vault", async () => {
		const calls: Array<{ key: string; value: string }> = [];
		const vault: VaultStub = {
			calls,
			setSecret: async (key, value) => {
				calls.push({ key, value });
				return true;
			},
		};
		const result = await mirrorSecretToVaultHandler(
			createRuntime({ secretValue: "sk-real", vault }) as never,
			createMessage() as never,
			undefined,
			{
				parameters: { key: "OPENAI_API_KEY", vaultName: "STEWARD_VAULT" },
			} as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { mirrored: boolean };
		expect(data.mirrored).toBe(true);
		expect(calls).toEqual([{ key: "OPENAI_API_KEY", value: "sk-real" }]);
	});

	test("returns mirrored=false when the vault service is not registered", async () => {
		const result = await mirrorSecretToVaultHandler(
			createRuntime({ secretValue: "sk-real", vault: null }) as never,
			createMessage() as never,
			undefined,
			{
				parameters: { key: "OPENAI_API_KEY", vaultName: "STEWARD_VAULT" },
			} as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		const data = result.data as { mirrored: boolean };
		expect(data.mirrored).toBe(false);
		expect(result.text).toContain("STEWARD_VAULT");
	});
});
