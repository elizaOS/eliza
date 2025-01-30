import { describe, it, expect } from 'vitest';
import { CommandParser } from '../../src/utils/command_parser';

describe('CommandParser', () => {
    describe('parseCommand', () => {
        it('should parse turn on commands', () => {
            const inputs = ['turn on', 'switch on', 'enable'];
            inputs.forEach(input => {
                const result = CommandParser.parseCommand(input);
                expect(result).toEqual({
                    command: 'turnOn',
                    args: undefined
                });
            });
        });

        it('should parse turn off commands', () => {
            const inputs = ['turn off', 'switch off', 'disable'];
            inputs.forEach(input => {
                const result = CommandParser.parseCommand(input);
                expect(result).toEqual({
                    command: 'turnOff',
                    args: undefined
                });
            });
        });

        it('should parse brightness commands with values', () => {
            const inputs = [
                ['set brightness to 50', '50'],
                ['dim to 25', '25'],
                ['brighten to 75', '75']
            ];
            inputs.forEach(([input, expectedValue]) => {
                const result = CommandParser.parseCommand(input);
                expect(result).toEqual({
                    command: 'setBrightness',
                    args: { value: expectedValue }
                });
            });
        });

        it('should parse temperature commands with values', () => {
            const inputs = [
                ['set temperature to 72', '72'],
                ['change temp to 68', '68']
            ];
            inputs.forEach(([input, expectedValue]) => {
                const result = CommandParser.parseCommand(input);
                expect(result).toEqual({
                    command: 'setTemperature',
                    args: { value: expectedValue }
                });
            });
        });

        it('should parse color commands with values', () => {
            const inputs = [
                ['change color to red', 'red'],
                ['set color to blue', 'blue']
            ];
            inputs.forEach(([input, expectedValue]) => {
                const result = CommandParser.parseCommand(input);
                expect(result).toEqual({
                    command: 'setColor',
                    args: { value: expectedValue }
                });
            });
        });

        it('should throw error for unknown commands', () => {
            expect(() => CommandParser.parseCommand('invalid command'))
                .toThrow('Unable to parse command');
        });
    });

    describe('mapToDeviceCommand', () => {
        it('should map turnOn command', () => {
            const result = CommandParser.mapToDeviceCommand('turnOn');
            expect(result).toEqual({
                capability: 'switch',
                command: 'on'
            });
        });

        it('should map turnOff command', () => {
            const result = CommandParser.mapToDeviceCommand('turnOff');
            expect(result).toEqual({
                capability: 'switch',
                command: 'off'
            });
        });

        it('should map setBrightness command with value', () => {
            const result = CommandParser.mapToDeviceCommand('setBrightness', { value: '50' });
            expect(result).toEqual({
                capability: 'switchLevel',
                command: 'setLevel',
                arguments: [50]
            });
        });

        it('should map setTemperature command with value', () => {
            const result = CommandParser.mapToDeviceCommand('setTemperature', { value: '72' });
            expect(result).toEqual({
                capability: 'thermostat',
                command: 'setTemperature',
                arguments: [72]
            });
        });

        it('should map setColor command with value', () => {
            const result = CommandParser.mapToDeviceCommand('setColor', { value: 'red' });
            expect(result).toEqual({
                capability: 'colorControl',
                command: 'setColor',
                arguments: [{ hex: 'red' }]
            });
        });

        it('should throw error for unknown commands', () => {
            expect(() => CommandParser.mapToDeviceCommand('invalidCommand'))
                .toThrow('Unknown command: invalidCommand');
        });
    });
});
