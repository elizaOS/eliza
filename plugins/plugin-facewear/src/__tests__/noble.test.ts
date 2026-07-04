/**
 * Noble transport tests exercise BLE discovery, lens routing, and notification
 * handling through in-memory peripherals.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { G1Command } from "../protocol/smartglasses.ts";
import {
	type NobleAdapterLike,
	type NobleCharacteristicLike,
	NobleG1Transport,
	type NoblePeripheralLike,
} from "../transport/noble.ts";

class FakeCharacteristic
	extends EventEmitter
	implements NobleCharacteristicLike
{
	readonly writes: number[][] = [];
	subscribed = false;
	unsubscribed = false;

	constructor(readonly uuid: string) {
		super();
	}

	async writeAsync(data: Buffer): Promise<void> {
		this.writes.push(Array.from(data));
	}

	async subscribeAsync(): Promise<void> {
		this.subscribed = true;
	}

	async unsubscribeAsync(): Promise<void> {
		this.unsubscribed = true;
	}
}

class FakePeripheral extends EventEmitter implements NoblePeripheralLike {
	connected = false;
	disconnected = false;
	readonly tx = new FakeCharacteristic("6e400002b5a3f393e0a9e50e24dcca9e");
	readonly rx = new FakeCharacteristic("6e400003b5a3f393e0a9e50e24dcca9e");

	constructor(readonly advertisement: { localName: string }) {
		super();
	}

	async connectAsync(): Promise<void> {
		this.connected = true;
	}

	async disconnectAsync(): Promise<void> {
		this.disconnected = true;
	}

	async discoverSomeServicesAndCharacteristicsAsync(): Promise<{
		characteristics: NobleCharacteristicLike[];
	}> {
		return { characteristics: [this.tx, this.rx] };
	}
}

class FakeNoble extends EventEmitter implements NobleAdapterLike {
	state = "poweredOn" as const;
	scanning = false;
	stopped = false;
	scanServiceUuids: string[] | null = null;
	readonly left = new FakePeripheral({ localName: "Even_G1_L_test" });
	readonly right = new FakePeripheral({ localName: "Even_G1_R_test" });

	async startScanningAsync(serviceUuids: string[]): Promise<void> {
		this.scanServiceUuids = serviceUuids;
		this.scanning = true;
		queueMicrotask(() => {
			this.emit("discover", this.left);
			this.emit("discover", this.right);
		});
	}

	async stopScanningAsync(): Promise<void> {
		this.stopped = true;
	}
}

describe("NobleG1Transport", () => {
	it("scans, connects, writes, subscribes, parses notifications, and disconnects", async () => {
		const noble = new FakeNoble();
		const transport = new NobleG1Transport(noble, { scanTimeoutMs: 1000 });
		const events: string[] = [];
		const audio: number[] = [];
		transport.onEvent((event) => events.push(event.label ?? event.type));
		transport.onAudio((pcm) => audio.push(...pcm));

		await transport.connect();
		expect(transport.isConnected()).toBe(true);
		expect(noble.scanning).toBe(true);
		expect(noble.scanServiceUuids).toEqual([]);
		expect(noble.stopped).toBe(true);
		expect(noble.left.connected).toBe(true);
		expect(noble.right.connected).toBe(true);
		expect(noble.left.rx.subscribed).toBe(true);
		expect(noble.right.rx.subscribed).toBe(true);

		await transport.writeBoth(Uint8Array.from([G1Command.SendResult, 1]));
		expect(noble.left.tx.writes[0]).toEqual([G1Command.SendResult, 1]);
		expect(noble.right.tx.writes[0]).toEqual([G1Command.SendResult, 1]);

		await transport.openMicrophone(true);
		expect(noble.right.tx.writes.at(-1)).toEqual([G1Command.OpenMic, 1]);

		noble.left.rx.emit("data", Buffer.from([0xf5, 0x00]));
		noble.right.rx.emit("data", Buffer.from([0xf1, 3, 4, 5]));
		expect(events).toContain("double_tap");
		expect(audio).toEqual([4, 5]);

		await transport.disconnect();
		expect(transport.isConnected()).toBe(false);
		expect(noble.left.disconnected).toBe(true);
		expect(noble.right.disconnected).toBe(true);
		expect(noble.left.rx.unsubscribed).toBe(true);
		expect(noble.right.rx.unsubscribed).toBe(true);
	});
});
