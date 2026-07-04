/**
 * Integration tests for basic-capabilities control-message delivery. Each test
 * boots a real AgentRuntime (allowNoDatabase, migrations skipped) with the
 * basic-capabilities plugin plus a stub transport service, asserting that
 * sendControlMessage routes through the typed CONTROL_TRANSPORT service and does
 * NOT fall back to a substring-name-matched socket service.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../runtime.ts";
import type { UUID } from "../../types/primitives.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import { Service, ServiceType } from "../../types/service.ts";
import type {
	ControlTransportMessage,
	IControlTransportService,
} from "../../types/service-interfaces.ts";
import { createBasicCapabilitiesPlugin } from "./index.ts";

describe("basic capabilities control transport", () => {
	it("delivers control messages through the typed control transport service", async () => {
		const sentMessages: ControlTransportMessage[] = [];

		class TestControlTransportService
			extends Service
			implements IControlTransportService
		{
			static override readonly serviceType = ServiceType.CONTROL_TRANSPORT;

			readonly capabilityDescription = "test control transport";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<TestControlTransportService> {
				return new TestControlTransportService(runtime);
			}

			async sendMessage(message: ControlTransportMessage): Promise<void> {
				sentMessages.push(message);
			}

			async stop(): Promise<void> {}
		}

		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		await runtime.registerPlugin(
			createBasicCapabilitiesPlugin({ disableBasic: true }),
		);
		await runtime.registerService(TestControlTransportService);
		await runtime.getServiceLoadPromise(ServiceType.CONTROL_TRANSPORT);

		await runtime.sendControlMessage({
			roomId: "00000000-0000-0000-0000-000000000001" as UUID,
			action: "disable_input",
			target: "composer",
		});

		expect(sentMessages).toEqual([
			{
				type: "controlMessage",
				payload: {
					action: "disable_input",
					target: "composer",
					roomId: "00000000-0000-0000-0000-000000000001",
				},
			},
		]);
	});

	it("does not fall back to substring-matched socket services", async () => {
		const socketMessages: unknown[] = [];

		class LegacySocketNamedService extends Service {
			static override readonly serviceType = "legacy_websocket";

			readonly capabilityDescription = "legacy socket service";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<LegacySocketNamedService> {
				return new LegacySocketNamedService(runtime);
			}

			async sendMessage(message: unknown): Promise<void> {
				socketMessages.push(message);
			}

			async stop(): Promise<void> {}
		}

		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const errorSpy = vi
			.spyOn(runtime.logger, "error")
			.mockImplementation(() => {});

		await runtime.registerPlugin(
			createBasicCapabilitiesPlugin({ disableBasic: true }),
		);
		await runtime.registerService(LegacySocketNamedService);

		await runtime.sendControlMessage({
			roomId: "00000000-0000-0000-0000-000000000002" as UUID,
			action: "enable_input",
		});

		expect(socketMessages).toEqual([]);
		expect(errorSpy).toHaveBeenCalledWith(
			{
				src: "basic-capabilities",
				agentId: runtime.agentId,
			},
			"No control transport service found to send control message",
		);
	});
});
