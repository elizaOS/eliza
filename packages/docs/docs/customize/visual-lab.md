---
displayed_sidebar: customizeSidebar
---

# Visual Customization Guide

Configure your agent's visual appearance across different platforms. While ElizaOS focuses on conversational AI, you can customize how your agent appears on Discord, Telegram, and other platforms.

## 🎨 What Visual Customization Is Available?

ElizaOS agents can be visually customized through platform-specific settings and character file properties. Each platform has its own visual capabilities that you can leverage.

### Customizable Elements

- 🖼️ **Avatar Images** - Profile pictures for your agent
- 📝 **Display Names** - How your agent appears in chats
- 🎨 **Platform Themes** - Work within platform constraints
- 💬 **Message Formatting** - Rich text and embeds
- 🏷️ **Status Messages** - Platform-specific status text
- 📊 **Embed Styles** - Rich message formatting

## 🚀 Platform-Specific Customization

### Discord Visual Options

#### Bot Avatar
Set your bot's profile picture through Discord Developer Portal:

1. Go to https://discord.com/developers/applications
2. Select your application
3. Navigate to "Bot" section
4. Click "Change Avatar" to upload image

**Image Requirements:**
- Format: PNG, JPG, GIF
- Size: 1024x1024px recommended
- File size: Under 8MB

#### Rich Embeds
Use Discord embeds for visually appealing responses:

```typescript
// In your action handler
return {
  embed: {
    title: "Agent Response",
    description: "Your formatted message here",
    color: 0xff9500, // Hex color
    thumbnail: {
      url: "https://example.com/icon.png"
    },
    fields: [
      {
        name: "Status",
        value: "Active",
        inline: true
      }
    ],
    footer: {
      text: "Powered by ElizaOS"
    }
  }
};
```

#### Bot Status
Configure your bot's status message:

```typescript
// In character settings
{
  "settings": {
    "discord": {
      "presence": {
        "status": "online", // online, idle, dnd
        "activity": {
          "type": "WATCHING", // PLAYING, WATCHING, LISTENING
          "name": "for questions"
        }
      }
    }
  }
}
```

### Telegram Visual Options

#### Bot Profile
Set through BotFather on Telegram:

1. Message @BotFather
2. Send `/mybots`
3. Select your bot
4. Edit bot picture, description, about text

#### Message Formatting
Telegram supports rich text formatting:

```typescript
// Markdown formatting
return {
  text: "*Bold text* _italic text_ `code`",
  parse_mode: "Markdown"
};

// HTML formatting
return {
  text: "<b>Bold</b> <i>italic</i> <code>code</code>",
  parse_mode: "HTML"
};
```

#### Inline Keyboards
Add interactive buttons to messages:

```typescript
return {
  text: "Choose an option:",
  reply_markup: {
    inline_keyboard: [
      [
        { text: "Option 1", callback_data: "opt1" },
        { text: "Option 2", callback_data: "opt2" }
      ]
    ]
  }
};
```

## 📋 Character File Visual Properties

### Avatar Configuration

```json
{
  "name": "MyAgent",
  "avatarUrl": "https://example.com/avatar.png",
  "coverUrl": "https://example.com/cover.jpg",
  "visualTheme": {
    "primaryColor": "#ff9500",
    "secondaryColor": "#1e293b",
    "fontFamily": "Inter, system-ui, sans-serif"
  }
}
```

### Platform-Specific Overrides

```json
{
  "settings": {
    "discord": {
      "displayName": "ElizaBot",
      "embedColor": "#ff9500"
    },
    "telegram": {
      "displayName": "Eliza Assistant",
      "parseMode": "Markdown"
    }
  }
}
```

## 🎨 Design Best Practices

### Avatar Design Tips

1. **Consistency** - Use the same avatar across platforms
2. **Clarity** - Ensure it's recognizable at small sizes
3. **Brand Alignment** - Match your agent's personality
4. **File Format** - Use PNG for transparency support

### Color Choices

Choose colors that:
- Reflect your agent's personality
- Are accessible (good contrast)
- Work in light and dark modes
- Stay within platform limitations

### Message Formatting

- Use formatting sparingly for emphasis
- Ensure readability on mobile devices
- Test appearance on different platforms
- Consider accessibility for all users

## 🛠️ Implementation Examples

### Discord Embed Builder

```typescript
function createRichResponse(title: string, description: string) {
  return {
    embed: {
      title,
      description,
      color: parseInt("ff9500", 16),
      timestamp: new Date().toISOString(),
      author: {
        name: "ElizaOS Agent",
        icon_url: "https://example.com/icon.png"
      },
      fields: [],
      footer: {
        text: "Powered by ElizaOS",
        icon_url: "https://example.com/footer-icon.png"
      }
    }
  };
}
```

### Telegram Formatted Response

```typescript
function formatTelegramMessage(content: string) {
  return {
    text: `🤖 *ElizaOS Response*\n\n${content}`,
    parse_mode: "Markdown",
    disable_web_page_preview: true
  };
}
```

## 📱 Responsive Considerations

### Mobile Optimization

- Keep messages concise for small screens
- Use line breaks effectively
- Test button layouts on mobile
- Ensure tap targets are large enough

### Cross-Platform Consistency

While each platform has limitations:
- Maintain consistent tone and personality
- Use similar color schemes where possible
- Keep branding elements recognizable
- Adapt to platform conventions

## 🔧 Testing Your Visual Setup

### Preview Tools

1. **Discord**: Use a test server to preview
2. **Telegram**: Create a test group
3. **Direct API**: Use Postman to test responses

### Validation Checklist

- [ ] Avatar displays correctly at all sizes
- [ ] Colors are accessible and readable
- [ ] Formatting works on all platforms
- [ ] Interactive elements function properly
- [ ] Mobile experience is optimized

## 🚀 Next Steps

After setting up visual customization:

1. **Test on Each Platform** - Verify appearance
2. **Gather Feedback** - Ask users about readability
3. **Iterate Design** - Refine based on usage
4. **Document Standards** - Create brand guidelines

For more customization:
- [Character Configuration](/docs/customize/character-builder)
- [Platform Setup Guides](/docs/customize/platform-setup)
- [Message Formatting Reference](/docs/api/messages)

---

**💡 Pro Tip**: Focus on clarity and readability over complex visual effects. A clean, consistent appearance that works well across all platforms is better than platform-specific elaborate designs.