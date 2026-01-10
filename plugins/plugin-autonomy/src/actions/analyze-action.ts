import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  logger,
  type ActionExample,
  createUniqueUuid,
  ModelType,
} from '@elizaos/core';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Analyze Action - Actually analyzes code, repositories, and data
 * This replaces fake "I'll analyze..." responses with real analysis
 */
export const analyzeDataAction: Action = {
  name: 'ANALYZE_DATA',
  similes: ['ANALYZE_CODE', 'EXAMINE_REPO', 'STUDY_STRUCTURE', 'REVIEW_PROJECT'],
  description: 'Actually analyzes code, project structure, and provides real insights',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('analyze') ||
      text.includes('examine') ||
      (text.includes('review') &&
        (text.includes('code') || text.includes('project') || text.includes('repo')))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    if (!callback) return;

    try {
      const text = message.content.text || '';

      // Extract what to analyze
      let targetPath = process.cwd(); // Default to current directory
      const pathMatch = text.match(
        /(?:analyze|examine|review)\s+(?:code|project|repo(?:sitory)?)\s+(?:at|in)?\s*([^\s]+)?/i
      );
      if (pathMatch && pathMatch[1]) {
        targetPath = pathMatch[1];
      }

      // Resolve path
      if (targetPath.startsWith('~/')) {
        targetPath = path.join(process.env.HOME || '', targetPath.substring(2));
      }
      targetPath = path.resolve(targetPath);

      // Check if path exists
      try {
        await fs.access(targetPath);
      } catch {
        throw new Error(`Path not found: ${targetPath}`);
      }

      // Analyze the directory/project structure
      const analysis = {
        path: targetPath,
        type: 'unknown',
        files: [] as string[],
        languages: new Set<string>(),
        frameworks: new Set<string>(),
        dependencies: {} as Record<string, any>,
        structure: {} as Record<string, number>,
        insights: [] as string[],
      };

      // Read directory structure
      const files = await fs.readdir(targetPath, { recursive: true });
      for (const file of files) {
        if (typeof file === 'string' && !file.includes('node_modules') && !file.includes('.git')) {
          analysis.files.push(file);

          // Detect languages by extension
          const ext = path.extname(file).toLowerCase();
          if (['.js', '.jsx', '.ts', '.tsx'].includes(ext))
            analysis.languages.add('JavaScript/TypeScript');
          if (['.py'].includes(ext)) analysis.languages.add('Python');
          if (['.rs'].includes(ext)) analysis.languages.add('Rust');
          if (['.go'].includes(ext)) analysis.languages.add('Go');
          if (['.java'].includes(ext)) analysis.languages.add('Java');

          // Count file types
          analysis.structure[ext] = (analysis.structure[ext] || 0) + 1;
        }
      }

      // Check for package.json (Node.js project)
      try {
        const packagePath = path.join(targetPath, 'package.json');
        const packageContent = await fs.readFile(packagePath, 'utf-8');
        const packageJson = JSON.parse(packageContent);
        analysis.type = 'Node.js/JavaScript';
        analysis.dependencies = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };

        // Detect frameworks
        if (packageJson.dependencies?.react) analysis.frameworks.add('React');
        if (packageJson.dependencies?.vue) analysis.frameworks.add('Vue');
        if (packageJson.dependencies?.express) analysis.frameworks.add('Express');
        if (packageJson.dependencies?.['@elizaos/core']) analysis.frameworks.add('ElizaOS');
      } catch {
        // Not a Node.js project or no package.json
      }

      // Generate insights using the model
      const insightPrompt = `Analyze this project structure and provide 3-5 key insights:
Path: ${targetPath}
Languages: ${Array.from(analysis.languages).join(', ')}
Frameworks: ${Array.from(analysis.frameworks).join(', ')}
File types: ${JSON.stringify(analysis.structure)}
Total files: ${analysis.files.length}

Provide actionable insights about:
1. Project organization
2. Technology stack
3. Potential improvements
4. Notable patterns`;

      const insights = await runtime.useModel(ModelType.TEXT_SMALL, {
        messages: [{ role: 'user', content: insightPrompt }],
        temperature: 0.7,
        maxTokens: 500,
      });

      // Parse insights into array
      const insightLines = insights.split('\n').filter((line) => line.trim().match(/^\d+\./));
      analysis.insights = insightLines;

      // Store analysis in memory
      await runtime.createMemory(
        {
          id: createUniqueUuid(runtime, 'analysis'),
          content: {
            text: `Analyzed project at: ${targetPath}`,
            data: analysis,
          },
          roomId: message.roomId,
          worldId: message.worldId,
          agentId: runtime.agentId,
          entityId: runtime.agentId,
          createdAt: Date.now(),
        },
        'knowledge'
      );

      // Provide detailed analysis results
      const thought = `I've completed a comprehensive analysis of the project at ${targetPath}.`;
      const responseText = `I've analyzed the project at: ${targetPath}

**Project Type:** ${analysis.type}
**Languages:** ${Array.from(analysis.languages).join(', ') || 'Not detected'}
**Frameworks:** ${Array.from(analysis.frameworks).join(', ') || 'None detected'}
**Total Files:** ${analysis.files.length}

**File Distribution:**
${Object.entries(analysis.structure)
  .sort(([, a], [, b]) => b - a)
  .slice(0, 5)
  .map(([ext, count]) => `- ${ext || 'no extension'}: ${count} files`)
  .join('\n')}

**Key Dependencies:** ${Object.keys(analysis.dependencies).slice(0, 5).join(', ') || 'None found'}

**Analysis Insights:**
${analysis.insights.join('\n') || insights}

This analysis has been stored for future reference.`;

      await callback({
        text: responseText,
        thought,
        actions: ['ANALYZE_DATA'],
        source: message.content.source,
        data: {
          targetPath,
          fileCount: analysis.files.length,
          languages: Array.from(analysis.languages),
          success: true,
        },
      });
    } catch (error) {
      logger.error('Error in analyzeData handler:', error);
      await callback({
        text: `Error analyzing project: ${error instanceof Error ? error.message : 'Unknown error'}`,
        actions: ['ANALYZE_DATA_ERROR'],
        source: message.content.source,
      });
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Analyze the code repository structure',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've analyzed the project at: /current/directory\n\n**Project Type:** Node.js/JavaScript\n**Languages:** JavaScript/TypeScript\n**Total Files:** 45\n\n[Detailed analysis would appear here]",
          actions: ['ANALYZE_DATA'],
        },
      },
    ],
  ] as ActionExample[][],
};
