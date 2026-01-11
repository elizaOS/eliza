# @elizaos/plugin-discord

A Discord plugin implementation for ElizaOS, enabling rich integration with Discord servers for managing interactions, voice, and message handling.

## Features

- Handle server join events and manage initial configurations
- Voice event management via the voice manager
- Manage and process new messages with the message manager
- Slash command registration and interaction handling
- Support for Discord attachments and media files
- Voice channel join/leave functionality
- Conversation summarization
- Media transcription capabilities
- Channel state and voice state providers
- Channel restriction support (limit bot to specific channels)
- Robust permissions management and audit event tracking
- Event-driven architecture with comprehensive event handling
- History backfill with efficient batch processing

## Installation

As this is a workspace package, it's installed as part of the ElizaOS monorepo:

```bash
bun install
```

## Configuration

The plugin requires the following environment variables:

```bash
# Discord API Credentials (Required)
DISCORD_APPLICATION_ID=your_application_id
DISCORD_API_TOKEN=your_api_token

# Channel Restrictions (Optional)
# Comma-separated list of Discord channel IDs to restrict the bot to.
# If not set, the bot operates in all channels.
# These channels cannot be removed via the leaveChannel action.
CHANNEL_IDS=123456789012345678,987654321098765432

# Listen-only channels (Optional)
# Comma-separated list of channel IDs where the bot will only listen (not respond).
DISCORD_LISTEN_CHANNEL_IDS=123456789012345678

# Voice Channel (Optional)
# ID of the voice channel the bot should auto-join when scanning a guild.
# If not set, the bot selects based on member activity.
DISCORD_VOICE_CHANNEL_ID=123456789012345678

# Behavior Settings (Optional)
# If true, ignore messages from other bots (default: false)
DISCORD_SHOULD_IGNORE_BOT_MESSAGES=false

# If true, ignore direct messages (default: false)
DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES=false

# If true, only respond when explicitly @mentioned (default: false)
DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS=false

# Testing (Optional)
DISCORD_TEST_CHANNEL_ID=123456789012345678
```

Settings can also be configured in your character file under `settings.discord`:

```json
{
  "settings": {
    "discord": {
      "shouldIgnoreBotMessages": false,
      "shouldIgnoreDirectMessages": false,
      "shouldRespondOnlyToMentions": false,
      "allowedChannelIds": ["123456789012345678"]
    }
  }
}
```

## Usage

```json
{
  "plugins": ["@elizaos/plugin-discord"]
}
```

## Slash Command Permissions

The plugin uses a hybrid permission system that combines Discord's native features with ElizaOS-specific controls.

### Permission Layers

Commands go through multiple permission checks in this order:

1. **Discord Native Checks** (before interaction fires):
   - User must have required Discord permissions
   - Command must be available in the current context (guild vs DM)

2. **ElizaOS Channel Whitelist** (if `CHANNEL_IDS` is set):
   - Commands only work in whitelisted channels
   - Unless command has `bypassChannelWhitelist: true`

3. **Custom Validator** (if provided):
   - Runs custom validation logic
   - Full programmatic control

### Registering Commands

```typescript
import { PermissionFlagsBits } from "discord.js";

// Simple command (works everywhere)
const helpCommand = {
  name: "help",
  description: "Show help information",
};

// Guild-only command
const serverInfoCommand = {
  name: "serverinfo",
  description: "Show server information",
  guildOnly: true,
};

// Requires Discord permission
const configCommand = {
  name: "config",
  description: "Configure bot settings",
  requiredPermissions: PermissionFlagsBits.ManageGuild,
};

// Bypasses channel whitelist
const utilityCommand = {
  name: "export",
  description: "Export data",
  bypassChannelWhitelist: true,
};

// Advanced: custom validation
const adminCommand = {
  name: "admin",
  description: "Admin-only command",
  validator: async (interaction, runtime) => {
    const adminIds = runtime.getSetting("ADMIN_USER_IDS")?.split(",") ?? [];
    return adminIds.includes(interaction.user.id);
  },
};

// Register commands
await runtime.emitEvent(["DISCORD_REGISTER_COMMANDS"], {
  commands: [
    helpCommand,
    serverInfoCommand,
    configCommand,
    utilityCommand,
    adminCommand,
  ],
});
```

### Permission Options

| Option                   | Type               | Description                                                           |
| ------------------------ | ------------------ | --------------------------------------------------------------------- |
| `guildOnly`              | `boolean`          | If true, command only works in guilds (not DMs)                       |
| `bypassChannelWhitelist` | `boolean`          | If true, bypasses `CHANNEL_IDS` restrictions                          |
| `requiredPermissions`    | `bigint \| string` | Discord permission bitfield (e.g., `PermissionFlagsBits.ManageGuild`) |
| `contexts`               | `number[]`         | Raw Discord contexts (0=Guild, 1=BotDM, 2=PrivateChannel)             |
| `guildIds`               | `string[]`         | Register only in specific guilds (instant updates)                    |
| `validator`              | `function`         | Custom validation function for advanced logic                         |

### Common Permission Values

From Discord.js `PermissionFlagsBits`:

- `ManageGuild` - Server settings
- `ManageChannels` - Channel management
- `ManageMessages` - Delete messages
- `BanMembers` - Ban users
- `KickMembers` - Kick users
- `ModerateMembers` - Timeout users
- `ManageRoles` - Role management
- `Administrator` - Full access

### Design Rationale

**Why Hybrid Approach?**

- Discord's native permissions are powerful but limited to role-based access
- ElizaOS needs programmatic control for channel restrictions and custom logic
- Combining both gives developers the best of both worlds

**Why Simple Flags?**

- `guildOnly: true` is clearer than `contexts: [0]`
- Abstracts Discord API details
- Sensible defaults: zero config should "just work"

**Why Keep Channel Whitelist?**

- Discord's channel permissions are UI-based (Server Settings > Integrations)
- Programmatic control is better for developer experience
- Allows dynamic, runtime-based channel restrictions

### Available Actions

The plugin provides the following actions:

| Action                  | Description                                |
| ----------------------- | ------------------------------------------ |
| **chatWithAttachments** | Handle messages with Discord attachments   |
| **createPoll**          | Create a poll in a Discord channel         |
| **downloadMedia**       | Download media files from Discord messages |
| **getUserInfo**         | Get information about a Discord user       |
| **joinVoice**           | Join a voice channel                       |
| **leaveVoice**          | Leave a voice channel                      |
| **listChannels**        | List channels in a Discord server          |
| **pinMessage**          | Pin a message in a channel                 |
| **reactToMessage**      | Add a reaction to a message                |
| **readChannel**         | Read messages from a channel               |
| **searchMessages**      | Search for messages in a channel           |
| **sendDM**              | Send a direct message to a user            |
| **serverInfo**          | Get information about the current server   |
| **summarize**           | Summarize conversation history             |
| **transcribeMedia**     | Transcribe audio/video media to text       |
| **unpinMessage**        | Unpin a message from a channel             |

### Providers

The plugin includes two state providers:

1. **channelStateProvider** - Provides state information about Discord channels
2. **voiceStateProvider** - Provides state information about voice channels and connection status

### Event Types

The plugin emits the following Discord-specific events:

| Event                                 | Description                               |
| ------------------------------------- | ----------------------------------------- |
| `DISCORD_MESSAGE_RECEIVED`            | When a message is received                |
| `DISCORD_MESSAGE_SENT`                | When a message is sent                    |
| `DISCORD_SLASH_COMMAND`               | When a slash command is invoked           |
| `DISCORD_MODAL_SUBMIT`                | When a modal form is submitted            |
| `DISCORD_REACTION_RECEIVED`           | When a reaction is added to a message     |
| `DISCORD_REACTION_REMOVED`            | When a reaction is removed from a message |
| `DISCORD_WORLD_JOINED`                | When the bot joins a guild                |
| `DISCORD_SERVER_CONNECTED`            | When connected to a server                |
| `DISCORD_USER_JOINED`                 | When a user joins a guild                 |
| `DISCORD_USER_LEFT`                   | When a user leaves a guild                |
| `DISCORD_VOICE_STATE_CHANGED`         | When voice state changes                  |
| `DISCORD_CHANNEL_PERMISSIONS_CHANGED` | When channel permissions change           |
| `DISCORD_ROLE_PERMISSIONS_CHANGED`    | When role permissions change              |
| `DISCORD_MEMBER_ROLES_CHANGED`        | When a member's roles change              |
| `DISCORD_ROLE_CREATED`                | When a role is created                    |
| `DISCORD_ROLE_DELETED`                | When a role is deleted                    |

## Key Components

### DiscordService

Main service class that extends ElizaOS Service:

- Handles authentication and session management
- Manages Discord client connection
- Processes events and interactions
- Supports channel history backfill with efficient batch processing

### MessageManager

- Processes incoming messages and responses
- Handles attachments and media files
- Supports message formatting and templating
- Manages conversation context

### VoiceManager

- Manages voice channel interactions
- Handles joining and leaving voice channels
- Processes voice events and audio streams
- Integrates with transcription services

### Attachment Handler

- Downloads and processes Discord attachments
- Supports various media types
- Integrates with media transcription

## Developer Guide

### Custom Slash Commands

Register slash commands via the `DISCORD_REGISTER_COMMANDS` event, then listen for interactions:

```typescript
// Register custom slash commands
await runtime.emitEvent(["DISCORD_REGISTER_COMMANDS"], {
  commands: [
    {
      name: "mycommand",
      description: "My custom command",
      options: [
        {
          name: "input",
          description: "User input",
          type: 3, // STRING type
          required: true,
        },
      ],
    },
    {
      name: "serverinfo",
      description: "Get server information",
      guildOnly: true, // Only works in guilds, not DMs
    },
  ],
});

// Listen for slash command events to handle the interaction
runtime.registerEvent({
  name: "DISCORD_SLASH_COMMAND",
  handler: async (payload) => {
    const { interaction, client, commands } = payload;

    if (interaction.commandName === "mycommand") {
      const input = interaction.options.getString("input");
      await interaction.reply(`You said: ${input}`);
    }
  },
});
```

### Building on the Listen System

The `DISCORD_LISTEN_CHANNEL_IDS` setting creates "listen-only" channels where the bot receives messages but doesn't respond. This is useful for:

- **Monitoring channels** - Track activity without interrupting conversations
- **Data collection** - Gather messages for analysis or training
- **Conditional responses** - Build custom logic that decides when to respond

```typescript
// Check if a channel is listen-only
const listenChannels = runtime.getSetting("DISCORD_LISTEN_CHANNEL_IDS");
const listenChannelIds = listenChannels?.split(",").map((s) => s.trim()) || [];

runtime.registerEvent({
  name: "DISCORD_MESSAGE_RECEIVED",
  handler: async (payload) => {
    const { message } = payload;
    const channelId = message.content.channelId;

    if (listenChannelIds.includes(channelId)) {
      // This is a listen-only channel - process without responding
      await processMessageSilently(message);
    }
  },
});
```

### Handling Modal and Component Interactions

Modal submits and message components (buttons, select menus) bypass channel whitelists to support multi-step UI flows:

```typescript
// Listen for modal submissions
runtime.registerEvent({
  name: "DISCORD_MODAL_SUBMIT",
  handler: async (payload) => {
    const { interaction } = payload;
    const fieldValue = interaction.fields.getTextInputValue("myField");
    await interaction.reply(`Received: ${fieldValue}`);
  },
});
```

### Permission Audit System

The plugin includes a comprehensive permission audit system that tracks all permission changes with full audit log integration. This is useful for:

- **Security monitoring** - Detect unauthorized permission escalations
- **Compliance logging** - Maintain records of who changed what and when
- **Bot self-protection** - Detect when the bot's permissions are modified

#### Event Payloads

**DISCORD_CHANNEL_PERMISSIONS_CHANGED** - When channel overwrites change:

```typescript
interface ChannelPermissionsChangedPayload {
  runtime: IAgentRuntime;
  guild: { id: string; name: string };
  channel: { id: string; name: string };
  target: { type: "role" | "user"; id: string; name: string };
  action: "CREATE" | "UPDATE" | "DELETE";
  changes: Array<{
    permission: string; // e.g., 'ManageMessages', 'Administrator'
    oldState: "ALLOW" | "DENY" | "NEUTRAL";
    newState: "ALLOW" | "DENY" | "NEUTRAL";
  }>;
  audit: {
    executorId: string;
    executorTag: string;
    reason: string | null;
  } | null;
}
```

**DISCORD_ROLE_PERMISSIONS_CHANGED** - When role permissions change:

```typescript
interface RolePermissionsChangedPayload {
  runtime: IAgentRuntime;
  guild: { id: string; name: string };
  role: { id: string; name: string };
  changes: PermissionDiff[];
  audit: AuditInfo | null;
}
```

**DISCORD_MEMBER_ROLES_CHANGED** - When a member's roles change:

```typescript
interface MemberRolesChangedPayload {
  runtime: IAgentRuntime;
  guild: { id: string; name: string };
  member: { id: string; tag: string };
  added: Array<{ id: string; name: string; permissions: string[] }>;
  removed: Array<{ id: string; name: string; permissions: string[] }>;
  audit: AuditInfo | null;
}
```

**DISCORD_ROLE_CREATED / DISCORD_ROLE_DELETED** - Role lifecycle:

```typescript
interface RoleLifecyclePayload {
  runtime: IAgentRuntime;
  guild: { id: string; name: string };
  role: { id: string; name: string; permissions: string[] };
  audit: AuditInfo | null;
}
```

#### Example: Security Monitoring

```typescript
import { DiscordEventTypes } from "@elizaos/plugin-discord";

// Alert on dangerous permission grants
runtime.registerEvent({
  name: DiscordEventTypes.CHANNEL_PERMISSIONS_CHANGED,
  handler: async (payload) => {
    const dangerousPerms = ["Administrator", "ManageGuild", "ManageRoles"];

    for (const change of payload.changes) {
      if (
        dangerousPerms.includes(change.permission) &&
        change.newState === "ALLOW"
      ) {
        console.warn(`⚠️ Dangerous permission granted!`, {
          channel: payload.channel.name,
          target: payload.target.name,
          permission: change.permission,
          grantedBy: payload.audit?.executorTag || "Unknown",
        });
      }
    }
  },
});

// Track role escalations
runtime.registerEvent({
  name: DiscordEventTypes.MEMBER_ROLES_CHANGED,
  handler: async (payload) => {
    const adminRoles = payload.added.filter((r) =>
      r.permissions.includes("Administrator"),
    );

    if (adminRoles.length > 0) {
      console.warn(`⚠️ Admin role granted to ${payload.member.tag}`, {
        roles: adminRoles.map((r) => r.name),
        grantedBy: payload.audit?.executorTag || "Unknown",
      });
    }
  },
});

// Log all role creations
runtime.registerEvent({
  name: DiscordEventTypes.ROLE_CREATED,
  handler: async (payload) => {
    console.log(`New role created: ${payload.role.name}`, {
      permissions: payload.role.permissions,
      createdBy: payload.audit?.executorTag || "Unknown",
    });
  },
});
```

#### Bot Self-Protection

Monitor when the bot's own permissions change:

```typescript
runtime.registerEvent({
  name: DiscordEventTypes.MEMBER_ROLES_CHANGED,
  handler: async (payload) => {
    const botId = runtime.getSetting("DISCORD_APPLICATION_ID");

    if (payload.member.id === botId && payload.removed.length > 0) {
      console.error(`🚨 Bot roles removed!`, {
        removed: payload.removed.map((r) => r.name),
        by: payload.audit?.executorTag || "Unknown",
      });
      // Could trigger alerts, notifications, etc.
    }
  },
});
```

## Cross-Core Compatibility

This plugin includes a compatibility layer (`compat.ts`) that allows it to work with both old and new versions of `@elizaos/core`. The compatibility layer:

- Automatically handles `serverId` vs `messageServerId` differences
- Uses a runtime proxy to intercept and adapt API calls
- Requires no changes to existing code

When migrating to a new core version, see the comments in `compat.ts` for removal instructions.

## Testing

The plugin includes a test suite for validating functionality:

```bash
bun run test
```

## Notes

- Ensure that your `.env` file includes the required `DISCORD_API_TOKEN`
- The bot requires appropriate Discord permissions (send messages, connect to voice, etc.)
- If no token is provided, the plugin will load but remain non-functional with appropriate warnings
- The plugin uses Discord.js v14.18.0 with comprehensive intent support
- Slash commands and modal/component interactions bypass channel whitelists
