# ElizaOS Home Plugin

## Purpose

Enables agents to control smart home devices, scenes, and rooms through SmartThings integration, handling commands like "turn on the lights" or "set the thermostat to 72 degrees."

## Key Features

- Control various smart home devices (lights, switches, thermostats, locks, etc.)
- Execute scenes and automations
- Discover available devices and their current states
- Process natural language commands for device control
- Group devices by room for organized management
- Support for multiple device capabilities (switch, level, color, temperature, etc.)

## Prerequisites

- A SmartThings account with connected devices
- A SmartThings personal access token
- ElizaOS installed and configured

## Installation

```bash
bun install @elizaos-plugins/client-eliza-home
```

## Configuration

Environment Variable:

- `SMARTTHINGS_TOKEN` (Required): SmartThings personal access token

Add to agent configuration:

```json
{
  "clients": ["home"]
}
```

## Integration

Connects with ElizaOS to allow agents to control smart home devices through natural language commands.

## Example Usage

- "Turn on the living room lights"
- "Set the thermostat to 72 degrees"
- "Dim the bedroom lights to 50%"
- "What devices do you see?"
- "Activate movie night scene"

## Links

[SmartThings Developer Workspace](https://account.smartthings.com/tokens)
