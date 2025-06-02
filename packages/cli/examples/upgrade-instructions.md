# Safe Plugin Upgrade Instructions

## Setting Up Your Environment

### 1. Set Your API Key Safely

```bash
# Option 1: Set for current session only
export ANTHROPIC_API_KEY="your-api-key-here"

# Option 2: Add to your shell profile (more permanent)
echo 'export ANTHROPIC_API_KEY="your-api-key-here"' >> ~/.bashrc
source ~/.bashrc
```

### 2. Install Claude Code

```bash
# Install Claude Code CLI (required)
npm install -g @anthropic-ai/claude-code
```

## Running Single Plugin Upgrades

```bash
# Upgrade a local plugin
elizaos plugins upgrade ./plugin-example

# Upgrade from GitHub
elizaos plugins upgrade https://github.com/org/plugin-name

# Skip tests for faster migration (use with caution)
elizaos plugins upgrade ./plugin-example --skip-tests
```

## Batch Plugin Upgrades

### Using the Safe Script

1. Copy the example script:

```bash
cp examples/safe-upgrade-example.sh my-upgrades.sh
chmod +x my-upgrades.sh
```

2. Edit the plugin list:

```bash
PLUGINS=(
    "/tmp/plugin-giphy"
    "./my-plugins/plugin-discord"
    "https://github.com/elizaos-plugins/plugin-twitter"
)
```

3. Run the script:

```bash
./my-upgrades.sh
```

## Interactive Node.js Approach

For more control, use this Node.js script:

```javascript
// upgrade-plugins.js
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Check API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Please set ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

const plugins = ['./plugin-example', 'https://github.com/org/plugin-name'];

async function upgradePlugin(pluginPath) {
  console.log(`\nUpgrading: ${pluginPath}`);

  try {
    execSync(`elizaos plugins upgrade "${pluginPath}" --skip-tests`, {
      stdio: 'inherit',
      env: process.env,
    });
    return { plugin: pluginPath, success: true };
  } catch (error) {
    console.error(`Failed to upgrade ${pluginPath}:`, error.message);
    return { plugin: pluginPath, success: false, error: error.message };
  }
}

// Run upgrades
async function main() {
  const results = [];

  for (const plugin of plugins) {
    const result = await upgradePlugin(plugin);
    results.push(result);

    // Wait between upgrades
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  // Summary
  console.log('\n=== Upgrade Summary ===');
  results.forEach((r) => {
    console.log(`${r.success ? '✅' : '❌'} ${r.plugin}`);
  });
}

main().catch(console.error);
```

## Safety Checklist

Before running upgrades:

- [ ] API key is set as environment variable (not in code)
- [ ] Claude Code is installed
- [ ] You have backups of your plugins
- [ ] You're using version control (git)
- [ ] You've reviewed which plugins to upgrade
- [ ] You have sufficient disk space
- [ ] You're aware this will create new branches

## What NOT to Do

❌ **Never do this:**

```bash
# DON'T hardcode API keys
elizaos plugins upgrade ./plugin --api-key "sk-ant-xxxx"

# DON'T read from .env files in scripts
API_KEY=$(grep ANTHROPIC_API_KEY .env | cut -d'=' -f2)

# DON'T commit API keys to git
git add .env
```

✅ **Always do this:**

```bash
# DO use environment variables
export ANTHROPIC_API_KEY="your-key"
elizaos plugins upgrade ./plugin

# DO use secure credential management
# Consider using tools like 1Password CLI, AWS Secrets Manager, etc.
```

## Monitoring and Logs

The upgrade system creates detailed logs. Always review:

1. Changed files in the new branch
2. Test results
3. Migration validation output
4. Any error messages

```bash
# After upgrade, review changes
cd your-plugin
git diff main...1.x-claude
```

Remember: The upgrade system executes code, so only run it on repositories you trust!
