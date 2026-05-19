import { describe, expect, it } from "vitest";

import { deviceFilesystemPlugin } from "../index.js";
import { DeviceFilesystemBridge } from "../services/device-filesystem-bridge.js";

describe("deviceFilesystemPlugin", () => {
	it("registers the bridge service without device filesystem leaf actions", () => {
		expect(deviceFilesystemPlugin.services).toContain(DeviceFilesystemBridge);
		expect(deviceFilesystemPlugin.actions ?? []).toEqual([]);
	});
});
