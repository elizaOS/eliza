import { ButtplugClient, ButtplugNodeWebsocketClientConnector } from "buttplug";
import { validateIntifaceConfig, type IntifaceConfig } from "./environment";
import type {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
} from "@elizaos/core";
import { Service, ServiceType } from "@elizaos/core";
import {
    isPortAvailable,
    startIntifaceEngine,
    shutdownIntifaceEngine,
} from "./utils";

// Define the Device interface based on Buttplug device properties
interface Device {
    name: string;
    index: number;
    vibrate?: (strength: number) => Promise<void>;
    rotate?: (strength: number) => Promise<void>;
    stop?: () => Promise<void>;
    battery?: () => Promise<number>;
    id?: number;
}

interface ActionOptions {
    intensity?: number;
    duration?: number;
}

export interface IIntifaceService extends Service {
    vibrate(strength: number, duration: number): Promise<void>;
    rotate?(strength: number, duration: number): Promise<void>;
    getBatteryLevel?(): Promise<number>;
    isConnected(): boolean;
    getDevices(): Device[];
}

export class IntifaceService extends Service implements IIntifaceService {
    static serviceType: ServiceType = ServiceType.INTIFACE;
    private client: ButtplugClient;
    private connected = false;
    private devices: Map<string, Device> = new Map();
    private vibrateQueue: VibrateEvent[] = [];
    private isProcessingQueue = false;
    private config: IntifaceConfig | null = null;
    private maxVibrationIntensity = 1;
    private rampUpAndDown = false;
    private rampSteps = 20;
    private preferredDeviceName: string | undefined;

    constructor() {
        super();
        this.client = new ButtplugClient("Temporary Name");

        this.client.addListener(
            "deviceadded",
            this.handleDeviceAdded.bind(this)
        );
        this.client.addListener(
            "deviceremoved",
            this.handleDeviceRemoved.bind(this)
        );

        // Add cleanup handlers
        process.on("SIGINT", this.cleanup.bind(this));
        process.on("SIGTERM", this.cleanup.bind(this));
        process.on("exit", this.cleanup.bind(this));
    }

    private async cleanup() {
        try {
            if (this.connected) {
                await this.client.disconnect();
            }
            await shutdownIntifaceEngine();
        } catch (error) {
            console.error("[IntifaceService] Cleanup error:", error);
        }
    }

    getInstance(): IIntifaceService {
        return this;
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        this.config = await validateIntifaceConfig(runtime);
        this.preferredDeviceName = this.config.DEVICE_NAME;
        this.client = new ButtplugClient(this.config.INTIFACE_NAME);

        if (this.config.INTIFACE_URL) {
            await this.connect();
        }
    }

    async connect() {
        if (this.connected || !this.config) return;

        const portAvailable = await isPortAvailable(12345);

        if (portAvailable) {
            try {
                await startIntifaceEngine();
            } catch (error) {
                console.error("Failed to start Intiface Engine:", error);
                throw error;
            }
        } else {
            console.log(
                "Port 12345 is in use, assuming Intiface is already running"
            );
        }

        let retries = 5;
        while (retries > 0) {
            try {
                const connector = new ButtplugNodeWebsocketClientConnector(
                    this.config.INTIFACE_URL
                );

                await this.client.connect(connector);
                this.connected = true;
                await this.scanAndGrabDevices();
                return;
            } catch (error) {
                retries--;
                if (retries > 0) {
                    console.log(
                        `Connection attempt failed, retrying... (${retries} attempts left)`
                    );
                    await new Promise((r) => setTimeout(r, 2000));
                } else {
                    console.error(
                        "Failed to connect to Intiface server after all retries:",
                        error
                    );
                    throw error;
                }
            }
        }
    }

    private async scanAndGrabDevices() {
        await this.client.startScanning();
        console.log("Scanning for devices...");
        await new Promise((r) => setTimeout(r, 2000));

        for (const device of this.client.devices) {
            this.devices.set(device.name, device);
            console.log(`- ${device.name} (${device.index})`);
        }

        if (this.devices.size === 0) {
            console.log("No devices found");
        }
    }

    private async ensureDeviceAvailable() {
        if (!this.connected) {
            throw new Error("Not connected to Intiface server");
        }

        if (this.devices.size === 0) {
            await this.scanAndGrabDevices();
        }

        const devices = this.getDevices();
        if (devices.length === 0) {
            throw new Error("No devices available");
        }

        let targetDevice;
        if (this.preferredDeviceName) {
            targetDevice = this.devices.get(this.preferredDeviceName);
            if (!targetDevice) {
                console.warn(
                    `Preferred device ${this.preferredDeviceName} not found, using first available device`
                );
                targetDevice = devices[0];
            }
        } else {
            targetDevice = devices[0];
        }

        return targetDevice;
    }

    async disconnect() {
        if (!this.connected) return;
        await this.client.disconnect();
        this.connected = false;
        this.devices.clear();
    }

    private handleDeviceAdded(device: Device) {
        this.devices.set(device.name, device);
        console.log(`Device connected: ${device.name}`);
    }

    private handleDeviceRemoved(device: Device) {
        this.devices.delete(device.name);
        console.log(`Device disconnected: ${device.name}`);
    }

    getDevices() {
        return Array.from(this.devices.values());
    }

    isConnected() {
        return this.connected;
    }

    private async addToVibrateQueue(event: VibrateEvent) {
        this.vibrateQueue.push(event);
        if (!this.isProcessingQueue) {
            this.isProcessingQueue = true;
            await this.processVibrateQueue();
        }
    }

    private async processVibrateQueue() {
        while (this.vibrateQueue.length > 0) {
            const event = this.vibrateQueue[0];
            await this.handleVibrate(event);
            this.vibrateQueue.shift();
        }
        this.isProcessingQueue = false;
    }

    private async handleVibrate(event: VibrateEvent) {
        const targetDevice = await this.ensureDeviceAvailable();

        if (this.rampUpAndDown) {
            const steps = this.rampSteps;
            const rampLength = (event.duration * 0.2) / steps;
            let startIntensity = 0;
            let endIntensity = event.strength;
            let stepIntensity = (endIntensity - startIntensity) / steps;

            // Ramp up
            for (let i = 0; i <= steps; i++) {
                await targetDevice.vibrate(startIntensity + stepIntensity * i);
                await new Promise((r) => setTimeout(r, rampLength));
            }

            // Hold
            await new Promise((r) => setTimeout(r, event.duration * 0.54));

            // Ramp down
            startIntensity = event.strength;
            endIntensity = 0;
            stepIntensity = (endIntensity - startIntensity) / steps;

            for (let i = 0; i <= steps; i++) {
                await targetDevice.vibrate(startIntensity + stepIntensity * i);
                await new Promise((r) => setTimeout(r, rampLength));
            }
        } else {
            await targetDevice.vibrate(event.strength);
            await new Promise((r) => setTimeout(r, event.duration));
        }

        await targetDevice.stop();
    }

    async vibrate(strength: number, duration: number): Promise<void> {
        const targetDevice = await this.ensureDeviceAvailable();
        await this.addToVibrateQueue({
            strength,
            duration,
            deviceId: targetDevice.id,
        });
    }

    async getBatteryLevel(): Promise<number> {
        const targetDevice = await this.ensureDeviceAvailable();

        try {
            const battery = await targetDevice.battery();
            console.log(
                `Battery level for ${targetDevice.name}: ${battery * 100}%`
            );
            return battery;
        } catch (err) {
            console.error("Error getting battery level:", err);
            throw err;
        }
    }

    async rotate(strength: number, duration: number): Promise<void> {
        const targetDevice = await this.ensureDeviceAvailable();

        // Check if device supports rotation
        if (!targetDevice.rotateCmd) {
            throw new Error("Device does not support rotation");
        }

        if (this.rampUpAndDown) {
            await this.rampedRotate(targetDevice, strength, duration);
        } else {
            await targetDevice.rotate(strength);
            await new Promise((r) => setTimeout(r, duration));
            await targetDevice.stop();
        }
    }

    private async rampedRotate(
        device: Device,
        targetStrength: number,
        duration: number
    ) {
        if (!device.rotate || !device.stop) {
            throw new Error("Device does not support rotation");
        }

        const stepTime = (duration * 0.2) / this.rampSteps;

        // Ramp up
        for (let i = 0; i <= this.rampSteps; i++) {
            const intensity = (targetStrength / this.rampSteps) * i;
            await device.rotate(intensity);
            await new Promise((r) => setTimeout(r, stepTime));
        }

        // Hold
        await new Promise((r) => setTimeout(r, duration * 0.6));

        // Ramp down
        for (let i = this.rampSteps; i >= 0; i--) {
            const intensity = (targetStrength / this.rampSteps) * i;
            await device.rotate(intensity);
            await new Promise((r) => setTimeout(r, stepTime));
        }

        await device.stop();
    }
}

const vibrateAction: Action = {
    name: "VIBRATE",
    similes: ["VIBRATE_TOY", "VIBRATE_DEVICE", "START_VIBRATION", "BUZZ"],
    description: "Control vibration intensity of connected devices",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        try {
            await validateIntifaceConfig(runtime);
            return true;
        } catch {
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        options: ActionOptions,
        callback: HandlerCallback
    ) => {
        const service = runtime.getService<IIntifaceService>(
            ServiceType.INTIFACE
        );
        if (!service) {
            throw new Error("Intiface service not available");
        }

        // Extract intensity and duration from message
        // Default to 50% intensity for 2 seconds if not specified
        const intensity = options?.intensity ?? 0.5;
        const duration = options?.duration ?? 2000;

        await service.vibrate(intensity, duration);

        callback({
            text: `Vibrating at ${intensity * 100}% intensity for ${duration}ms`,
        });
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Vibrate the toy at 70% for 3 seconds" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Vibrating at 70% intensity for 3000ms",
                    action: "VIBRATE",
                    options: { intensity: 0.7, duration: 3000 },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Start vibrating" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Vibrating at 50% intensity for 2000ms",
                    action: "VIBRATE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Make it buzz at max power for 5 seconds" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Vibrating at 100% intensity for 5000ms",
                    action: "VIBRATE",
                    options: { intensity: 1.0, duration: 5000 },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Give me a gentle buzz" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Vibrating at 25% intensity for 2000ms",
                    action: "VIBRATE",
                    options: { intensity: 0.25, duration: 2000 },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Vibrate for 10 seconds" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Vibrating at 50% intensity for 10000ms",
                    action: "VIBRATE",
                    options: { intensity: 0.5, duration: 10000 },
                },
            },
        ],
    ],
};

const rotateAction: Action = {
    name: "ROTATE",
    similes: ["ROTATE_TOY", "ROTATE_DEVICE", "START_ROTATION", "SPIN"],
    description: "Control rotation intensity of connected devices",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        try {
            await validateIntifaceConfig(runtime);
            return true;
        } catch {
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        options: ActionOptions,
        callback: HandlerCallback
    ) => {
        const service = runtime.getService<IIntifaceService>(
            ServiceType.INTIFACE
        );
        if (!service || !service.rotate) {
            throw new Error("Rotation not supported");
        }

        const intensity = options?.intensity ?? 0.5;
        const duration = options?.duration ?? 2000;

        await service.rotate(intensity, duration);

        callback({
            text: `Rotating at ${intensity * 100}% intensity for ${duration}ms`,
        });
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Rotate the toy at 70% for 3 seconds" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Rotating at 70% intensity for 3000ms",
                    action: "ROTATE",
                    options: { intensity: 0.7, duration: 3000 },
                },
            },
        ],
    ],
};

const batteryAction: Action = {
    name: "BATTERY",
    similes: [
        "CHECK_BATTERY",
        "BATTERY_LEVEL",
        "TOY_BATTERY",
        "DEVICE_BATTERY",
    ],
    description: "Check battery level of connected devices",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        try {
            await validateIntifaceConfig(runtime);
            return true;
        } catch {
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: ActionOptions,
        callback: HandlerCallback
    ) => {
        const service = runtime.getService<IIntifaceService>(
            ServiceType.INTIFACE
        );
        if (!service || !service.getBatteryLevel) {
            throw new Error("Battery level check not supported");
        }

        try {
            const batteryLevel = await service.getBatteryLevel();
            callback({
                text: `Device battery level is at ${Math.round(batteryLevel * 100)}%`,
            });
        } catch {
            callback({
                text: "Unable to get battery level. Device might not support this feature.",
            });
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "What's the battery level?" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Device battery level is at 90%",
                    action: "BATTERY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Check toy battery" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Device battery level is at 75%",
                    action: "BATTERY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "How much battery is left?" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Device battery level is at 45%",
                    action: "BATTERY",
                },
            },
        ],
    ],
};

interface VibrateEvent {
    duration: number;
    strength: number;
    deviceId?: number;
}

export const intifacePlugin: Plugin = {
    name: "intiface",
    description: "Controls intimate hardware devices",
    actions: [vibrateAction, rotateAction, batteryAction],
    evaluators: [],
    providers: [],
    services: [new IntifaceService()],
};

export default intifacePlugin;
