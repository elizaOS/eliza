# ElizaOS Plugin System FAQ

## General Questions

### What are Plugins in ElizaOS?

Plugins are modular components that extend ElizaOS agent capabilities. They allow agents to interact with external services, process data, and perform specialized tasks. Plugins are designed to be maintained by their creators in separate repositories, making the system permissionless and scalable.

### Where can I find available plugins?

All available plugins can be found in the ElizaOS Plugin Registry: https://elizaos.github.io/registry/

### How do plugins work in ElizaOS?

Plugins provide interfaces and action handlers that agents can use to interact with external systems or process data in specific ways. When an agent needs to perform an action that a plugin supports, it will invoke the relevant plugin functionality through the ElizaOS runtime.

## Plugin Development

### How can I start building a plugin?

Use the starter template: https://github.com/elizaOS/eliza/blob/v2-develop/packages/plugin-starter/src/index.ts
This template provides the basic structure for an ElizaOS plugin.

### What are best practices for plugin development?

- Include comprehensive README documentation
- Set correct permissions for PR collaboration
- Add step-by-step tutorials or videos when possible
- Follow the example PR structure: https://github.com/elizaos-plugins/registry/pull/35
- Ensure your code is well-tested before submission
- Keep your plugin focused on a specific functionality domain

### What's the plugin review process?

Plugins are no longer merged into the main repository but are maintained in their own repositories. Review is only needed for registry listing. The review may take up to a week.

### How long does the Registry PR review process take?

It's hard to say, depending on team bandwidth. We suggest planning for up to a week, so please plan accordingly.

### How do I add my plugin to the ElizaOS Plugin Registry?

Once you've hosted your plugin in your repo, please add an issue to the Plugin repo pointing correctly to your repository, and add a modification to the registry. Then submit PR to edit the registry here: https://github.com/elizaos-plugins/registry

### How can I get my plugin review expedited?

Post your PR in the following channel in elizaOS developer server to help provide additional visibility: https://discord.com/channels/1051457140637827122/1323745969115893780

## Plugin Usage

### How do I install a plugin?

Add the plugin to your agent's character definition:

```typescript
const character = {
  name: 'MyAgent',
  plugins: [
    '@elizaos/plugin-anthropic',
    '@elizaos/plugin-discord',
    // Add more plugins as needed
  ],
  // Rest of character definition
};
```

### How do I know which plugins to use for my agent?

Consider your agent's specific needs:

- Communication channels: Discord, Telegram, XMTP
- AI capabilities: Anthropic, OpenAI
- Data processing: SQL, PDF
- Media handling: Video Understanding

For specific agent types:

1. Customer support agents: Communication plugins + AI + knowledge base
2. Data analysis agents: SQL plugin + visualization capabilities
3. Content moderation: Media processing + AI plugins
4. Community managers: Social platform plugins + content scheduling

### How do I update plugins?

Plugins automatically reflect the latest version from their default branch in their repository. When you want to update a plugin, simply push changes to the default branch of your repository.

### How frequently can maintainers release new versions?

Maintainers can release updates as frequently as needed, as long as they push to the default branch. There are no restrictions on release frequency.

## Plugin Maintenance

### What is the Plugin release procedure?

To update your Plugin, please push the updated code to the default branch on your repo. Since this is already pointing to the correct repository on the ElizaOS Plugin Registry, this will always reflect your most updated code.

### Do I need to maintain backward compatibility?

While not strictly required, it's strongly recommended to maintain backward compatibility when updating your plugin to avoid breaking existing agents that depend on it. If breaking changes are necessary, consider versioning your plugin.

### How does plugin versioning work?

Having a plugin listed in the registry does not require it to be under elizaos-plugins organizations. As part of the current transition state, some plugins are published under the elizaos-plugins organization and some are not. In a future state, only plugins considered "official plugins" will remain in elizaos-plugins.

### How can users report issues with my plugin?

Users should report issues through the plugin's GitHub repository issue tracker. Make sure to include clear instructions in your README on how users can report issues or request features.

## Technical Questions

### How do I handle authentication in my plugin?

Authentication details should be provided through the agent's settings.secrets configuration. Never hardcode credentials in your plugin code. Here's an example:

```typescript
// In your plugin
export const myPlugin = {
  actions: {
    async authenticatedAction(params, context) {
      const { API_KEY } = context.secrets;
      // Use API_KEY for authentication
    },
  },
};

// In the agent configuration
const character = {
  // ...
  settings: {
    secrets: {
      API_KEY: process.env.MY_SERVICE_API_KEY,
    },
  },
};
```

### How do I handle errors in my plugin?

Always catch and handle errors appropriately in your plugin. Return meaningful error messages that will help users understand what went wrong and how to fix it. For example:

```typescript
async function riskyOperation(params) {
  try {
    // Operation that might fail
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: {
        message: 'Operation failed',
        details: error.message,
        code: error.code || 'UNKNOWN_ERROR',
      },
    };
  }
}
```

### Can my plugin depend on other plugins?

Yes, plugins can depend on other plugins. Make sure to document these dependencies clearly in your README so users know what other plugins they need to include.

### Are there size limitations for plugins?

While there are no strict size limitations, it's recommended to keep your plugin focused and lightweight. If your plugin requires large dependencies, consider splitting it into multiple plugins or use dynamic imports to load resources only when needed.

## Community and Support

### Where can I get help with plugin development?

- Join the ElizaOS developer Discord server: [Discord Link]
- Post questions in the #plugin-development channel
- Check out existing plugins for examples
- Review the official documentation at [Documentation Link]

### How can I contribute to existing plugins?

Contact the plugin maintainer through their GitHub repository or submit pull requests with improvements or bug fixes. Make sure to follow the contribution guidelines specified in the plugin's repository.

### Can I fork and modify existing plugins?

Yes, you can fork existing plugins and modify them for your needs, as long as you respect the original license terms. If you make significant improvements, consider contributing them back to the original plugin.
