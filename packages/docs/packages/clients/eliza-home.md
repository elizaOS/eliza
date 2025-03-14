# ElizaOS Home Plugin

The ElizaOS Home Plugin enables agents to control smart home devices, scenes, and rooms through SmartThings integration. This plugin allows your agent to interact with your smart home ecosystem, handling commands like "turn on the lights" or "set the thermostat to 72 degrees."

## Features

- Control various smart home devices (lights, switches, thermostats, locks, etc.)
- Execute scenes and automations
- Discover available devices and their current states
- Process natural language commands for device control
- Group devices by room for organized management
- Support for multiple device capabilities (switch, level, color, temperature, etc.)

## Prerequisites

Before using this plugin, you need:

1. A SmartThings account with connected devices
2. A SmartThings personal access token
3. ElizaOS installed and configured

## Setup

### 1. Get SmartThings API Token

1. Go to the [SmartThings Developer Workspace](https://account.smartthings.com/tokens)
2. Create a new Personal Access Token with the following scopes:
   - `r:devices:*` (read devices)
   - `x:devices:*` (execute device commands)
   - `r:scenes:*` (read scenes)
   - `x:scenes:*` (execute scenes)
   - `r:rooms:*` (read rooms information)
3. Save your token securely; you'll need it for configuration

### 2. Configure the Plugin

Add the following environment variable to your ElizaOS configuration:

```
SMARTTHINGS_TOKEN="your_smartthings_personal_access_token"
```

### 3. Install the Plugin

To install the plugin to your ElizaOS agent:

```bash
npm install @elizaos-plugins/client-eliza-home
```

### 4. Add the Plugin to Your Agent Configuration

Add the Home client to your agent's configuration:

```json
{
  "clients": [
    "home"
  ]
}
```

## Usage

Once configured, your agent can:

### Control Devices

Users can send natural language commands to control devices:

- "Turn on the living room lights"
- "Set the thermostat to 72 degrees"
- "Dim the bedroom lights to 50%"
- "Turn off all the lights in the kitchen"
- "Lock the front door"

### Discover Devices

Users can ask about available devices:

- "What devices do you see?"
- "List all the smart devices"
- "What lights do I have?"

### Check Device Status

Users can inquire about the current state of devices:

- "Is the living room light on?"
- "What's the current temperature of the thermostat?"
- "Are any doors unlocked?"

### Execute Scenes

Users can trigger scenes by name:

- "Activate movie night scene"
- "Run good morning routine"

## Supported Device Types

The plugin supports a variety of device types:

- **Switches**: Basic on/off control
- **Lights**: On/off, brightness, color, temperature control
- **Thermostats**: Temperature control, mode setting
- **Locks**: Lock/unlock control
- **Sensors**: Motion, contact, presence, temperature, humidity
- **Window Shades and Garage Doors**: Open/close control
- **Fans**: On/off, speed control
- **Media Players**: Play/pause/stop, volume control

## Configuration Options

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `SMARTTHINGS_TOKEN` | Yes | SmartThings personal access token |

## Troubleshooting

### Connection Issues

If the plugin can't connect to SmartThings:

1. Verify your token is correct and has the required permissions
2. Check your internet connection
3. Ensure the SmartThings service is available

### Command Processing Problems

If commands aren't being processed correctly:

1. Make sure your phrasing is clear (e.g., "turn on the kitchen light")
2. Check if the device name matches exactly what's in SmartThings
3. Verify the device is online and responsive in the SmartThings app

### Device Discovery Issues

If devices aren't appearing:

1. Make sure devices are properly set up in SmartThings
2. Check that your token has read access to devices
3. Try refreshing the device list in SmartThings

## Development

To extend or modify this plugin:

1. Clone the repository
2. Install dependencies: `npm install`
3. Make your changes
4. Run tests: `npm test`
5. Build: `npm run build`
