#!/usr/bin/env node
import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';

// Run the scenario using the CLI commands
async function runGitHubTodoScenarioTest() {
  console.log(chalk.cyan('🚀 Running GitHub-Todo Scenario Test\n'));

  try {
    // Validate environment
    const requiredEnvVars = ['GITHUB_TOKEN', 'OPENAI_API_KEY'];
    const missingVars = requiredEnvVars.filter((v: any) => !process.env[v]);

    if (missingVars.length > 0) {
      console.error(
        chalk.red(`❌ Missing required environment variables: ${missingVars.join(', ')}`)
      );
      console.log(chalk.yellow('\n📝 Please set the following environment variables:'));
      for (const varName of missingVars) {
        console.log(chalk.yellow(`   export ${varName}=your_value_here`));
      }
      process.exit(1);
    }

    // Check if the scenario file exists
    const scenarioPath = path.join(
      process.cwd(),
      'scenarios/plugin-tests/02-github-todo-workflow.ts'
    );
    try {
      await fs.access(scenarioPath);
      console.log(chalk.green(`✓ Found scenario file: ${path.basename(scenarioPath)}\n`));
    } catch {
      console.error(chalk.red(`❌ Scenario file not found at: ${scenarioPath}`));
      process.exit(1);
    }

    // Create a test character that uses the GitHub and Todo plugins
    const testCharacter = {
      name: 'GitHub Todo Assistant',
      system: `You are a helpful project management assistant that integrates GitHub issues with todo task management.

Your capabilities:
- Fetch GitHub issues using LIST_GITHUB_ISSUES action
- Create todo tasks from issues using CREATE_TODO action
- Update todo status using UPDATE_TODO action
- Create pull requests using CREATE_GITHUB_PULL_REQUEST action
- List todos using LIST_TODOS action

When asked to check GitHub issues, always use the LIST_GITHUB_ISSUES action first.
When creating todos, include the issue number in the todo title.
Be clear about what actions you're taking and provide helpful summaries.`,
      bio: [
        "I'm a project management assistant specializing in GitHub integration",
        'I help teams track issues and manage tasks efficiently',
        'I bridge the gap between GitHub issues and personal todo lists',
      ],
      topics: [
        'project management',
        'github',
        'todo tracking',
        'software development',
        'issue tracking',
      ],
      style: {
        all: ['helpful', 'organized', 'clear', 'proactive'],
        chat: ['friendly', 'informative', 'action-oriented'],
        post: ['concise', 'structured', 'informative'],
      },
      adjectives: ['organized', 'efficient', 'helpful', 'proactive', 'detail-oriented'],
      examples: [],
      plugins: ['@elizaos/plugin-github', '@elizaos/plugin-todo'],
    };

    // Save the test character to a temporary file
    const characterPath = path.join(process.cwd(), '.test-character-github-todo.json');
    await fs.writeFile(characterPath, JSON.stringify(testCharacter, null, 2));
    console.log(chalk.blue('📝 Created test character configuration\n'));

    // Import the necessary modules
    const { spawn } = await import('child_process');

    // Run the scenario test using the CLI
    console.log(chalk.blue('🎬 Running scenario test...\n'));

    const testProcess = spawn(
      'node',
      [
        'dist/index.js',
        'scenario',
        'test',
        '--scenarios',
        '02-github-todo-workflow',
        '--character',
        characterPath,
        '--verbose',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          GITHUB_OWNER: process.env.GITHUB_OWNER || 'elizaOS',
          GITHUB_REPO: process.env.GITHUB_REPO || 'eliza',
        },
        stdio: 'pipe',
      }
    );

    // Capture output
    let output = '';
    let errorOutput = '';

    testProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    testProcess.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      process.stderr.write(chalk.red(text));
    });

    // Wait for the process to complete
    const exitCode = await new Promise<number>((resolve) => {
      testProcess.on('close', (code) => {
        resolve(code || 0);
      });
    });

    // Clean up the temporary character file
    try {
      await fs.unlink(characterPath);
    } catch {
      // Ignore errors
    }

    // Check results
    console.log(chalk.cyan('\n\n📊 Test Results:\n'));

    if (exitCode === 0) {
      console.log(chalk.green('✅ Scenario test PASSED!\n'));

      // Parse the output for key information
      const actionMatches = output.match(/Executing action: ([A-Z_]+)/g) || [];
      if (actionMatches.length > 0) {
        console.log(chalk.cyan('🎯 Actions executed:'));
        const uniqueActions = [
          ...new Set(actionMatches.map((m) => m.replace('Executing action: ', ''))),
        ];
        for (const action of uniqueActions) {
          console.log(chalk.yellow(`   - ${action}`));
        }
        console.log();
      }

      // Check if expected actions were executed
      const expectedActions = ['LIST_GITHUB_ISSUES', 'CREATE_TODO', 'UPDATE_TODO'];
      const executedActions = new Set(
        actionMatches.map((m) => m.replace('Executing action: ', ''))
      );
      const missingActions = expectedActions.filter((a) => !executedActions.has(a));

      if (missingActions.length > 0) {
        console.log(chalk.yellow('⚠️  Warning: Some expected actions were not executed:'));
        for (const action of missingActions) {
          console.log(chalk.yellow(`   - ${action}`));
        }
        console.log(
          chalk.yellow('\nThis might be due to the conversation flow or action availability.\n')
        );
      }
    } else {
      console.log(chalk.red(`❌ Scenario test FAILED with exit code: ${exitCode}\n`));

      if (errorOutput.includes('Missing required environment variables')) {
        console.log(chalk.yellow('💡 Tip: Make sure all required environment variables are set.'));
      } else if (errorOutput.includes('not found')) {
        console.log(chalk.yellow('💡 Tip: Make sure the project is built with `npm run build`.'));
      }
    }

    process.exit(exitCode);
  } catch (error) {
    console.error(chalk.red('\n❌ Test failed with error:'));
    console.error(error);
    process.exit(1);
  }
}

// Run the test
runGitHubTodoScenarioTest().catch(console.error);
