/**
 * DOCUMENTATION MIGRATION STEPS
 * 
 * Responsibilities:
 * - README.md creation with V2 documentation standards
 * - Plugin documentation templates
 * - Usage examples and configuration guides
 */

import * as fs from 'fs-extra';
import * as path from 'node:path';
import type { MigrationContext, StepResult } from '../types.js';

export class DocumentationSteps {
  private context: MigrationContext;

  constructor(context: MigrationContext) {
    this.context = context;
  }

  /**
   * Create comprehensive README.md with V2 documentation
   */
  async createReadme(ctx: MigrationContext): Promise<StepResult> {
    const readmeTemplate = `# @elizaos/plugin-${ctx.pluginName}

Brief description of what this plugin does.

## Installation

\`\`\`bash
npm install @elizaos/plugin-${ctx.pluginName}
\`\`\`

## Configuration

Add to your \`.eliza/.env\` file:

\`\`\`bash
# Add plugin-specific environment variables here
MY_API_KEY=your_api_key_here
MY_API_ENDPOINT=https://api.example.com
MY_ENABLE_FEATURE=true
\`\`\`

## Usage

\`\`\`typescript
import ${ctx.pluginName}Plugin from '@elizaos/plugin-${ctx.pluginName}';

// Add to your ElizaOS configuration
const plugins = [${ctx.pluginName}Plugin];
\`\`\`

## Actions

- \`MY_ACTION\` - Performs plugin functionality

## Providers

- \`myState\` - Provides current plugin state

## Development

\`\`\`bash
bun run dev    # Development mode
bun run build  # Build for production
bun run test   # Run tests
bun run lint   # Lint code
\`\`\`

## License

MIT`;

    await fs.writeFile(path.join(ctx.repoPath, 'README.md'), readmeTemplate);
    ctx.changedFiles.add('README.md');

    return {
      success: true,
      message: 'Created README.md',
      changes: ['README.md'],
    };
  }
} 