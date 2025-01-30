import { IAgentRuntime } from "@elizaos/core";

// Define SmartThings capability interfaces
export interface SmartThingsCapability {
  id: string;
  version: number;
}

export const CAPABILITIES = {
  // Basic capabilities
  SWITCH: { id: 'switch', version: 1 },
  POWER_METER: { id: 'powerMeter', version: 1 },
  ENERGY_METER: { id: 'energyMeter', version: 1 },

  // Climate capabilities
  THERMOSTAT: { id: 'thermostat', version: 1 },
  TEMPERATURE_MEASUREMENT: { id: 'temperatureMeasurement', version: 1 },
  HUMIDITY_MEASUREMENT: { id: 'humidityMeasurement', version: 1 },

  // Lighting capabilities
  SWITCH_LEVEL: { id: 'switchLevel', version: 1 },
  COLOR_CONTROL: { id: 'colorControl', version: 1 },
  COLOR_TEMPERATURE: { id: 'colorTemperature', version: 1 },

  // Security capabilities
  LOCK: { id: 'lock', version: 1 },
  MOTION_SENSOR: { id: 'motionSensor', version: 1 },
  CONTACT_SENSOR: { id: 'contactSensor', version: 1 },
  PRESENCE_SENSOR: { id: 'presenceSensor', version: 1 },

  // Media capabilities
  MEDIA_PLAYBACK: { id: 'mediaPlayback', version: 1 },
  VOLUME: { id: 'volume', version: 1 },

  // Window/Door capabilities
  WINDOW_SHADE: { id: 'windowShade', version: 1 },
  GARAGE_DOOR: { id: 'garageDoor', version: 1 },

  // Fan capabilities
  FAN_SPEED: { id: 'fanSpeed', version: 1 },

  // Battery capabilities
  BATTERY: { id: 'battery', version: 1 },
} as const;

export type CapabilityType = keyof typeof CAPABILITIES;

export interface Capability {
    interface: string;
    version: string;
    type: string;
    properties: {
        supported: Array<{
            name: string;
        }>;
        proactivelyReported: boolean;
        retrievable: boolean;
    };
}

export class CapabilityManager {
    private runtime: IAgentRuntime;
    private capabilities: Map<string, Capability>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.capabilities = new Map();
        this.initializeCapabilities();
    }

    private initializeCapabilities() {
        // Add standard capabilities
        this.addCapability({
            interface: "Alexa.PowerController",
            version: "3",
            type: "AlexaInterface",
            properties: {
                supported: [{ name: "powerState" }],
                proactivelyReported: true,
                retrievable: true,
            },
        });

        this.addCapability({
            interface: "Alexa.BrightnessController",
            version: "3",
            type: "AlexaInterface",
            properties: {
                supported: [{ name: "brightness" }],
                proactivelyReported: true,
                retrievable: true,
            },
        });

        // Add more capabilities as needed
    }

    addCapability(capability: Capability) {
        this.capabilities.set(capability.interface, capability);
    }

    getCapability(interfaceName: string): Capability | undefined {
        return this.capabilities.get(interfaceName);
    }

    getAllCapabilities(): Capability[] {
        return Array.from(this.capabilities.values());
    }
}