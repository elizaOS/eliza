# @elizaos/plugin-letzai

![LetzAI Logo](https://letz.ai/_next/image?url=%2FL.png&w=64&q=100)

A plugin to integrate LetzAI Image Generation capabilities into the elizaos ecosystem.

It uses the [LetzAI API](https://www.letz.ai/docs/api) and can use any models available to API user.

Users need to add their LETZAI_API_KEY in .env file.


## Description

[LetzAI](https://www.letz.ai) is an image generation platform and visual discovery engine. It enables anyone to generate images about anything, by allowing users to add themselves, their products or their art style to the platform as AI Models.

This plugin integrates LetzAI with Eliza, enabling agents to generate images using any LetzAI Models, including the ones you may have created specifically of or for your agent.

To use this plugin, you will need a LetzAI API Key, which [can be created on your subscription page here](https://www.letz.ai/subscription). A subscription is required to create an API key.

To generate images the plugin introduces its own GENERATE_IMAGE action.

The plugin was not tested together with other image generation functionalities.


## Installation

```bash
pnpm install @elizaos/plugin-letzai
```


## Configuration

### Environment Variables
```typescript
LETZAI_API_LEY=<Your LetzAI API Key>
LETZAI_MODELS="@hailee, @examplemodel2"
```

Inside the plugin's index.tsx file is a "improvePrompt" variable and some code that is commented out. This code could be enhanced to make the instructions from chat be passed to the API in a better way. This is an open TO DO.

## Development Guide

### Setting Up Development Environment

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```


## Example

I am currently working on an example Agent called ["HaileeAgent"](https://x.com/AgentHailee).
Will share more information on this as I progress.



## Other Notes
In my own character.json file for Hailee, I have integrated the plugin like this:
```json
    "plugins": ["../../packages/plugin-letzai/src/index.ts"],
    "actions": ["GENERATE_IMAGE"],
```

But I'm not sure yet this is the correct way for public repos.


## Future Enhancements

- Interactive agent with better image polling
- Enable "Improve prompt" functionality

If anybody knows how to make the agent be pro-active and send multiple callbacks(), please reach out.



## Contributing

This Plugin is developed by LetzAI. Any helpful contributions are welcome!


## Credits

Built by [mitch0z](https://www.mitchoz.com)


## License

This plugin is part of the Eliza project. See the main project repository for license information.
