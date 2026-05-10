# @elizaos/plugin-imessage

iMessage plugin for ElizaOS agents. Enables chat integration with Apple's iMessage on macOS.

**Note: This plugin only works on macOS systems.**

## Features

- **Send Messages**: Send text messages via iMessage
- **Direct & Group Chats**: Support for direct messages and group conversations
- **Attachments**: Send media attachments (via CLI tool)
- **Message Polling**: Receive incoming messages via polling
- **Policy Controls**: Configure DM and group policies

## Requirements

- **macOS**: This plugin only works on macOS
- **Messages App Access**: Full Disk Access permission may be required
- **Optional CLI Tool**: For enhanced functionality, use an iMessage CLI tool

## Installation

```bash
# npm
npm install @elizaos/plugin-imessage

# bun
bun add @elizaos/plugin-imessage
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `IMESSAGE_CLI_PATH` | Path to iMessage CLI tool | No |
| `IMESSAGE_DB_PATH` | Path to iMessage database | No |
| `IMESSAGE_POLL_INTERVAL_MS` | Polling interval in ms | No |
| `IMESSAGE_DM_POLICY` | DM policy: open, pairing, allowlist, disabled | No |
| `IMESSAGE_GROUP_POLICY` | Group policy: open, allowlist, disabled | No |
| `IMESSAGE_ALLOW_FROM` | Comma-separated handles for allowlist | No |
| `IMESSAGE_ENABLED` | Enable/disable the plugin | No |

### Agent Configuration

```json
{
  "plugins": ["@elizaos/plugin-imessage"],
  "pluginParameters": {
    "IMESSAGE_DM_POLICY": "pairing",
    "IMESSAGE_GROUP_POLICY": "allowlist",
    "IMESSAGE_POLL_INTERVAL_MS": "5000"
  }
}
```

## Setup

### Permissions

1. Open System Preferences > Security & Privacy > Privacy
2. Grant Full Disk Access to:
   - Terminal (or your terminal app)
   - Your Node.js/Python executable
3. Allow Messages app to be controlled via AppleScript

### CLI Tool (Optional)

For enhanced functionality, you can use an iMessage CLI tool like `imsg`:

```bash
# Install a CLI tool (example)
brew install imessage-cli

# Configure the path
IMESSAGE_CLI_PATH=/usr/local/bin/imsg
```

## Usage

### Actions

iMessage sending is exposed through the canonical message connector action. Use
`source: "imessage"` when a request needs to target iMessage explicitly.

| Primary action | Operation | Description |
|----------------|-----------|-------------|
| `MESSAGE` | `send` | Send a text message to a phone number, email, contact, or chat |

### Providers

iMessage does not register standalone planner providers. Chat and contact
context is exposed through the iMessage message connector hooks.

## How It Works

The plugin uses two methods to interact with iMessage:

1. **AppleScript** (default): Uses macOS's built-in scripting support to send messages through the Messages app
2. **CLI Tool** (optional): Uses a command-line tool for more features

### AppleScript Method

```applescript
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "+1234567890" of targetService
  send "Hello!" to targetBuddy
end tell
```

## Message Targets

iMessage supports multiple target types:

- **Phone Numbers**: `+1234567890`, `1234567890`
- **Email Addresses**: `user@example.com`
- **Chat IDs**: `chat_id:UUID` (for existing chats)

## Policies

### DM Policies

| Policy | Description |
|--------|-------------|
| `open` | Accept DMs from anyone |
| `pairing` | Accept DMs and remember senders |
| `allowlist` | Only accept from IMESSAGE_ALLOW_FROM list |
| `disabled` | Don't accept any DMs |

### Group Policies

| Policy | Description |
|--------|-------------|
| `open` | Respond to anyone in groups |
| `allowlist` | Only respond to allowed users |
| `disabled` | Don't respond in groups |

## Limitations

- **macOS Only**: iMessage doesn't have an official API and only works on macOS
- **No Official API**: Relies on AppleScript or CLI tools
- **Permissions**: Requires Full Disk Access and Automation permissions
- **Rate Limits**: Apple may throttle excessive automation

## Development

### Building

```bash
cd typescript && npm run build
```

### Testing

Testing requires a macOS environment with Messages app configured:

```bash
npm test
```

## Troubleshooting

### "Cannot access Messages app"

1. Ensure Full Disk Access is granted
2. Ensure Automation permissions are granted
3. Try opening Messages app manually first

### "Service not available"

1. Check that you're running on macOS
2. Verify the Messages app is installed and configured

### Messages not sending

1. Check that iMessage is signed in and working
2. Verify the recipient has iMessage enabled
3. Check for rate limiting (try again later)

## License

MIT
