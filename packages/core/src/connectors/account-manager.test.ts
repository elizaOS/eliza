import { describe, expect, it, vi } from "vitest";
import type { TargetInfo } from "../types";
import type {
	IAgentRuntime,
	MessageConnectorRegistration,
	PostConnectorRegistration,
} from "../types/runtime";
import { getConnectorAccountManager } from "./account-manager";

class TestRuntime {
	private messageConnectors: MessageConnectorRegistration[] = [];
	private postConnectors: PostConnectorRegistration[] = [];

	getService(): undefined {
		return undefined;
	}

	getMessageConnectors(): MessageConnectorRegistration[] {
		return this.messageConnectors;
	}

	registerMessageConnector(connector: MessageConnectorRegistration): void {
		this.messageConnectors.push(connector);
	}

	getPostConnectors(): PostConnectorRegistration[] {
		return this.postConnectors;
	}

	registerPostConnector(connector: PostConnectorRegistration): void {
		this.postConnectors.push(connector);
	}

	async sendMessageToTarget(target: TargetInfo, content: { text: string }) {
		const connector = this.messageConnectors.find(
			(candidate) => candidate.source === target.source,
		);
		await connector?.sendHandler?.(
			this as unknown as IAgentRuntime,
			target,
			content,
		);
	}
}

function makeRuntime(): IAgentRuntime {
	return new TestRuntime() as unknown as IAgentRuntime;
}

function makeTarget(source: string): TargetInfo {
	return {
		source,
		roomId: "00000000-0000-0000-0000-00000000000c" as TargetInfo["roomId"],
	};
}

describe("ConnectorAccountManager", () => {
	it("does not duplicate an existing MessageConnector source during provider registration", async () => {
		const runtime = makeRuntime();
		const existingSendHandler = vi.fn(async () => undefined);
		const providerSendHandler = vi.fn(async () => undefined);

		runtime.registerMessageConnector({
			source: "chat",
			sendHandler: existingSendHandler,
			fetchMessages: async () => [],
		});

		const manager = getConnectorAccountManager(runtime);
		const result = manager.registerProvider({
			provider: "chat",
			messageConnector: {
				source: "chat",
				sendHandler: providerSendHandler,
				fetchMessages: async () => [],
			},
		});

		expect(result.messageConnectorRegistered).toBe(false);
		expect(result.messageConnectorSkipped).toBe(true);
		expect(runtime.getMessageConnectors()).toHaveLength(1);

		await runtime.sendMessageToTarget(makeTarget("chat"), { text: "hello" });
		expect(existingSendHandler).toHaveBeenCalledOnce();
		expect(providerSendHandler).not.toHaveBeenCalled();
	});
});
