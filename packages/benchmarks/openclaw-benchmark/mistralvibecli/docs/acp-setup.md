# ACP Setup

Mistral Vibe can be used in text editors and IDEs that support [Agent Client Protocol](https://agentclientprotocol.com/overview/clients). Mistral Vibe includes the `vibe-acp` tool.
Once you have set up `vibe` with the API keys, you are ready to use `vibe-acp` in your editor. Below are the setup instructions for some editors that support ACP.

## Zed

For usage in Zed, we recommend using the [Mistral Vibe Zed's extension](https://zed.dev/extensions/mistral-vibe). Alternatively, you can set up a local install as follows:

1. Go to `~/.config/zed/settings.json` and, under the `agent_servers` JSON object, add the following key-value pair to invoke the `vibe-acp` command. Here is the snippet:

```json
{
   "agent_servers": {
      "Mistral Vibe": {
         "type": "custom",
         "command": "vibe-acp",
         "args": [],
         "env": {}
      }
   }
}
```

2. In the `New Thread` pane on the right, select the `vibe` agent and start the conversation.

## JetBrains IDEs

1. Add the following snippet to your JetBrains IDE acp.json ([documentation](https://www.jetbrains.com/help/ai-assistant/acp.html)):

```json
{
  "agent_servers": {
    "Mistral Vibe": {
      "command": "vibe-acp",
    }
  }
}
```

2. In the AI Chat agent selector, select the new Mistral Vibe agent and start the conversation.

## Neovim (using avante.nvim)

Add Mistral Vibe in the acp_providers section of your configuration

```lua
{
  acp_providers = {
    ["mistral-vibe"] = {
      command = "vibe-acp",
      env = {
         MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY"), -- necessary if you setup Mistral Vibe manually
      },
    }
  }
}
```
