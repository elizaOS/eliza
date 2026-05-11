# Registry Update Checklist

Registry:
- [ ] I've made the left side of the colon of JSON entry in index.json match the potential NPM package name
- [ ] I've used github not github.com
- [ ] There is no .git extension
- [ ] It's placed it alphabetically in the list
- [ ] I've dealt with commas properly so the list is still valid JSON

If not an eliza-plugins official repo, i.e. new plugin: 

The plugin repo has:
- [ ] is publically accessible (not a private repo)
- [ ] uses main as it's default branch
- [ ] I have include `elizaos-plugins` in the topics in the GitHub repo settings. If the plugin is related to `AI` or `crypto`, please add those as topics as well.
- [ ] add simple description in github repo
- [ ] follows this convention
```
plugin-name/
├── images/
│   ├── logo.jpg        # Plugin branding logo
│   ├── banner.jpg      # Plugin banner image
├── src/
│   ├── index.ts        # Main plugin entry point
│   ├── actions/        # Plugin-specific actions
│   ├── clients/        # Client implementations
│   ├── adapters/       # Adapter implementations
│   └── types.ts        # Type definitions
│   └── environment.ts  # runtime.getSetting, zod validation
├── package.json        # Plugin dependencies
└── README.md          # Plugin documentation
```
- [ ] an `images/banner.jpg` and `images/logo.jpg` and they
  - Use clear, high-resolution images
  - Keep file sizes optimized (< 500KB for logos, < 1MB for banners)
  - Follow the [elizaOS Brand Guidelines](https://github.com/elizaOS/brandkit)
  - Include alt text for accessibility
- [ ] package.json has a agentConfig like the following
```json
{
  "name": "@myNpmOrg/plugin-example",
  "version": "1.0.0",
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "API_KEY": {
        "type": "string",
        "description": "API key for the service"
      }
    }
  }
}
```

<!-- If you are on Discord, please join https://discord.gg/elizaOS and state your Discord username here for the contributor role and join us in #development-feed -->
<!--
## Discord username

-->
