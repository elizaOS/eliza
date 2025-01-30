import { DeviceCommand } from '../types/smart_things';

export class CommandParser {
  private static readonly COMMAND_PATTERNS = {
    turnOn: /turn on|switch on|enable/i,
    turnOff: /turn off|switch off|disable/i,
    setBrightness: /set brightness to (\d+)|dim to (\d+)|brighten to (\d+)/i,
    setTemperature: /set temperature to (\d+)|change temp to (\d+)/i,
    setColor: /change color to (\w+)|set color to (\w+)/i,
    lock: /lock|secure/i,
    unlock: /unlock|unsecure/i,
    open: /open|raise/i,
    close: /close|lower/i,
  };

  static parseCommand(text: string): { command: string; args?: any } {
    for (const [action, pattern] of Object.entries(this.COMMAND_PATTERNS)) {
      const match = text.match(pattern);
      if (match) {
        const args = match.slice(1).find(arg => arg !== undefined);
        return {
          command: action,
          args: args ? { value: args } : undefined
        };
      }
    }
    throw new Error('Unable to parse command');
  }

  static mapToDeviceCommand(command: string, args?: any): DeviceCommand {
    switch (command) {
      case 'turnOn':
        return { capability: 'switch', command: 'on' };
      case 'turnOff':
        return { capability: 'switch', command: 'off' };
      case 'setBrightness':
        return {
          capability: 'switchLevel',
          command: 'setLevel',
          arguments: [parseInt(args.value)]
        };
      case 'setTemperature':
        return {
          capability: 'thermostat',
          command: 'setTemperature',
          arguments: [parseInt(args.value)]
        };
      case 'setColor':
        return {
          capability: 'colorControl',
          command: 'setColor',
          arguments: [{ hex: args.value }]
        };
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}