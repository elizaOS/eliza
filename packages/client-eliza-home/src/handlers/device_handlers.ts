import { SmartThingsApi } from "../services/smart_things_api";
import { DeviceState } from "../providers/device_state";

export class DeviceHandlers {
  constructor(private api: SmartThingsApi) {}

  async handleSwitch(deviceId: string, command: string): Promise<void> {
    await this.api.devices.executeCommand(deviceId, {
      capability: 'switch',
      command: command === 'on' ? 'on' : 'off'
    });
  }

  async handleLight(deviceId: string, command: string, args: any = {}): Promise<void> {
    const commands = [];

    if (command === 'on' || command === 'off') {
      commands.push({
        capability: 'switch',
        command: command
      });
    }

    if (args.brightness) {
      commands.push({
        capability: 'switchLevel',
        command: 'setLevel',
        arguments: [args.brightness]
      });
    }

    if (args.color) {
      commands.push({
        capability: 'colorControl',
        command: 'setColor',
        arguments: [args.color]
      });
    }

    await this.api.devices.executeCommands(deviceId, commands);
  }

  async handleThermostat(deviceId: string, command: string, args: any = {}): Promise<void> {
    const commands = [];

    if (args.temperature) {
      commands.push({
        capability: 'thermostat',
        command: 'setTemperature',
        arguments: [args.temperature]
      });
    }

    if (args.mode) {
      commands.push({
        capability: 'thermostat',
        command: 'setMode',
        arguments: [args.mode]
      });
    }

    await this.api.devices.executeCommands(deviceId, commands);
  }

  async handleLock(deviceId: string, command: string): Promise<void> {
    await this.api.devices.executeCommand(deviceId, {
      capability: 'lock',
      command: command === 'lock' ? 'lock' : 'unlock'
    });
  }

  async handleWindowShade(deviceId: string, command: string, args: any = {}): Promise<void> {
    const commands = [];

    switch (command) {
      case 'open':
        commands.push({
          capability: 'windowShade',
          command: 'open'
        });
        break;
      case 'close':
        commands.push({
          capability: 'windowShade',
          command: 'close'
        });
        break;
      case 'setLevel':
        if (args.level !== undefined) {
          commands.push({
            capability: 'windowShade',
            command: 'setLevel',
            arguments: [args.level]
          });
        }
        break;
    }

    await this.api.devices.executeCommands(deviceId, commands);
  }

  async handleFan(deviceId: string, command: string, args: any = {}): Promise<void> {
    const commands = [];

    if (command === 'on' || command === 'off') {
      commands.push({
        capability: 'switch',
        command: command
      });
    }

    if (args.speed !== undefined) {
      commands.push({
        capability: 'fanSpeed',
        command: 'setSpeed',
        arguments: [args.speed]
      });
    }

    await this.api.devices.executeCommands(deviceId, commands);
  }

  async handleGarageDoor(deviceId: string, command: string): Promise<void> {
    await this.api.devices.executeCommand(deviceId, {
      capability: 'garageDoor',
      command: command === 'open' ? 'open' : 'close'
    });
  }

  async handleMediaPlayer(deviceId: string, command: string, args: any = {}): Promise<void> {
    const commands = [];

    switch (command) {
      case 'play':
      case 'pause':
      case 'stop':
        commands.push({
          capability: 'mediaPlayback',
          command: command
        });
        break;
      case 'setVolume':
        if (args.volume !== undefined) {
          commands.push({
            capability: 'volume',
            command: 'setVolume',
            arguments: [args.volume]
          });
        }
        break;
    }

    await this.api.devices.executeCommands(deviceId, commands);
  }

  async handleSensor(deviceId: string, sensorType: string): Promise<any> {
    const status = await this.api.devices.getStatus(deviceId);

    switch (sensorType) {
      case 'motion':
        return status.motionSensor?.motion;
      case 'contact':
        return status.contactSensor?.contact;
      case 'presence':
        return status.presenceSensor?.presence;
      case 'temperature':
        return status.temperatureMeasurement?.temperature;
      case 'humidity':
        return status.humidityMeasurement?.humidity;
      case 'battery':
        return status.battery?.battery;
      default:
        throw new Error(`Unknown sensor type: ${sensorType}`);
    }
  }

  // Add other handlers for locks, sensors, covers, etc.
}