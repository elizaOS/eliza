#!/usr/bin/env node
/**
 * CLI inspector for viewing agent trajectories
 * Converted from inspector_cli.py
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Command } from 'commander';
import chalk from 'chalk';

interface TrajectoryStep {
  thought?: string;
  action?: string;
  response?: string;
  observation?: string;
  messages?: Array<{ role: string; content: string }>;
}

interface Trajectory {
  history?: Array<{ role: string; content: string }>;
  trajectory: TrajectoryStep[];
  info?: {
    exitStatus?: string;
    submission?: string;
    modelStats?: {
      instanceCost?: number;
      instanceInputTokens?: number;
      instanceOutputTokens?: number;
      instanceCallCount?: number;
      [key: string]: unknown;
    };
  };
  environment?: string;
}

/**
 * Load and parse a trajectory file
 */
function loadTrajectory(filePath: string): Trajectory | null {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Try JSON first, then YAML
  try {
    return JSON.parse(content);
  } catch {
    return yaml.load(content) as Trajectory;
  }
}

/**
 * Format a trajectory step for display
 */
function formatStep(step: TrajectoryStep, index: number): string {
  const lines: string[] = [];

  lines.push(chalk.cyan(`\n${'='.repeat(80)}`));
  lines.push(chalk.yellow(`Step ${index + 1}`));
  lines.push(chalk.cyan('='.repeat(80)));

  if (step.thought) {
    lines.push(chalk.green('💭 Thought:'));
    lines.push(`  ${step.thought}`);
  }

  if (step.action) {
    lines.push(chalk.blue('🎯 Action:'));
    lines.push(`  ${step.action}`);
  }

  if (step.response) {
    lines.push(chalk.magenta('📝 Response:'));
    lines.push(`  ${step.response}`);
  }

  if (step.observation) {
    lines.push(chalk.gray('👀 Observation:'));
    // Truncate long observations
    const obs = step.observation;
    if (obs.length > 500) {
      lines.push(`  ${obs.substring(0, 497)}...`);
    } else {
      lines.push(`  ${obs}`);
    }
  }

  return lines.join('\n');
}

/**
 * Display trajectory summary
 */
function displaySummary(trajectory: Trajectory): void {
  console.log(chalk.cyan('\n📊 Trajectory Summary'));
  console.log(chalk.cyan('='.repeat(80)));

  console.log(`  Total Steps: ${trajectory.trajectory.length}`);

  if (trajectory.info?.exitStatus) {
    console.log(`  Exit Status: ${chalk.yellow(trajectory.info.exitStatus)}`);
  }

  if (trajectory.info?.modelStats) {
    const stats = trajectory.info.modelStats;
    console.log(chalk.green('\n💰 Model Statistics:'));
    console.log(`  Cost: $${stats.instanceCost?.toFixed(4) || 0}`);
    console.log(`  Input Tokens: ${stats.instanceInputTokens || 0}`);
    console.log(`  Output Tokens: ${stats.instanceOutputTokens || 0}`);
    console.log(`  API Calls: ${stats.instanceCallCount || 0}`);
  }

  if (trajectory.info?.submission) {
    console.log(chalk.green('\n📤 Submission:'));
    const submission = trajectory.info.submission;
    if (submission.length > 200) {
      console.log(`  ${submission.substring(0, 197)}...`);
    } else {
      console.log(`  ${submission}`);
    }
  }
}

/**
 * Interactive mode for stepping through trajectory
 */
async function interactiveMode(trajectory: Trajectory): Promise<void> {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let currentStep = 0;

  const prompt = () => {
    return new Promise<string>((resolve) => {
      rl.question(
        chalk.cyan(`\n[Step ${currentStep + 1}/${trajectory.trajectory.length}] `) +
          '(n)ext, (p)revious, (j)ump, (s)ummary, (q)uit: ',
        resolve,
      );
    });
  };

  console.log(chalk.green('\n🔍 Interactive Trajectory Inspector'));
  console.log(chalk.gray('Navigate through the trajectory step by step\n'));

  // Display first step
  if (trajectory.trajectory.length > 0) {
    console.log(formatStep(trajectory.trajectory[0], 0));
  }

  while (true) {
    const command = (await prompt()).toLowerCase().trim();

    switch (command) {
      case 'n':
      case 'next':
        if (currentStep < trajectory.trajectory.length - 1) {
          currentStep++;
          console.log(formatStep(trajectory.trajectory[currentStep], currentStep));
        } else {
          console.log(chalk.yellow('Already at the last step'));
        }
        break;

      case 'p':
      case 'previous':
        if (currentStep > 0) {
          currentStep--;
          console.log(formatStep(trajectory.trajectory[currentStep], currentStep));
        } else {
          console.log(chalk.yellow('Already at the first step'));
        }
        break;

      case 'j':
      case 'jump':
        const jumpTo = await new Promise<string>((resolve) => {
          rl.question('Jump to step number: ', resolve);
        });
        const stepNum = parseInt(jumpTo) - 1;
        if (stepNum >= 0 && stepNum < trajectory.trajectory.length) {
          currentStep = stepNum;
          console.log(formatStep(trajectory.trajectory[currentStep], currentStep));
        } else {
          console.log(chalk.red('Invalid step number'));
        }
        break;

      case 's':
      case 'summary':
        displaySummary(trajectory);
        break;

      case 'q':
      case 'quit':
        rl.close();
        return;

      default:
        console.log(chalk.yellow('Unknown command. Use: (n)ext, (p)revious, (j)ump, (s)ummary, (q)uit'));
    }
  }
}

/**
 * Main CLI program
 */
const program = new Command();

program.name('swe-inspector').description('CLI tool for inspecting SWE-agent trajectories').version('1.0.0');

program
  .command('view <file>')
  .description('View a trajectory file')
  .option('-i, --interactive', 'Interactive mode (step through trajectory)')
  .option('-s, --summary', 'Show summary only')
  .option('-v, --verbose', 'Show full observations (no truncation)')
  .action(async (file: string, options) => {
    const filePath = path.resolve(file);

    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`File not found: ${filePath}`));
      process.exit(1);
    }

    const trajectory = loadTrajectory(filePath);

    if (!trajectory) {
      console.error(chalk.red('Failed to load trajectory'));
      process.exit(1);
    }

    if (options.summary) {
      displaySummary(trajectory);
    } else if (options.interactive) {
      await interactiveMode(trajectory);
    } else {
      // Display all steps
      trajectory.trajectory.forEach((step, index) => {
        console.log(formatStep(step, index));
      });
      displaySummary(trajectory);
    }
  });

program
  .command('list [directory]')
  .description('List trajectory files in a directory')
  .option('-s, --sort <field>', 'Sort by: name, date, size', 'date')
  .action((directory: string = './trajectories', options: { sort?: string }) => {
    const dir = path.resolve(directory);

    if (!fs.existsSync(dir)) {
      console.error(chalk.red(`Directory not found: ${dir}`));
      process.exit(1);
    }

    const files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.traj') || file.endsWith('.yaml') || file.endsWith('.json'))
      .map((file) => {
        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          path: filePath,
          size: stats.size,
          modified: stats.mtime,
        };
      });

    // Sort files
    switch (options.sort) {
      case 'name':
        files.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'size':
        files.sort((a, b) => b.size - a.size);
        break;
      case 'date':
      default:
        files.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    }

    console.log(chalk.cyan('\n📁 Trajectory Files'));
    console.log(chalk.cyan('='.repeat(80)));

    if (files.length === 0) {
      console.log(chalk.yellow('No trajectory files found'));
    } else {
      files.forEach((file) => {
        const size = (file.size / 1024).toFixed(1);
        const date = file.modified.toLocaleDateString();
        const time = file.modified.toLocaleTimeString();
        console.log(`  ${chalk.green(file.name.padEnd(40))} ${size.padStart(8)} KB  ${date} ${time}`);
      });
      console.log(chalk.gray(`\nTotal: ${files.length} files`));
    }
  });

program
  .command('stats [directory]')
  .description('Show statistics for all trajectories in a directory')
  .action((directory: string = './trajectories') => {
    const dir = path.resolve(directory);

    if (!fs.existsSync(dir)) {
      console.error(chalk.red(`Directory not found: ${dir}`));
      process.exit(1);
    }

    const files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.traj') || file.endsWith('.yaml') || file.endsWith('.json'));

    let totalCost = 0;
    let totalSteps = 0;
    let totalTokens = 0;
    const exitStatuses: Record<string, number> = {};

    files.forEach((file) => {
      const trajectory = loadTrajectory(path.join(dir, file));
      if (trajectory) {
        totalSteps += trajectory.trajectory.length;

        if (trajectory.info?.modelStats) {
          totalCost += trajectory.info.modelStats.instanceCost || 0;
          totalTokens +=
            (trajectory.info.modelStats.instanceInputTokens || 0) +
            (trajectory.info.modelStats.instanceOutputTokens || 0);
        }

        const status = trajectory.info?.exitStatus || 'unknown';
        exitStatuses[status] = (exitStatuses[status] || 0) + 1;
      }
    });

    console.log(chalk.cyan('\n📈 Trajectory Statistics'));
    console.log(chalk.cyan('='.repeat(80)));
    console.log(`  Total Trajectories: ${files.length}`);
    console.log(`  Total Steps: ${totalSteps}`);
    console.log(`  Average Steps: ${(totalSteps / files.length).toFixed(1)}`);
    console.log(`  Total Cost: $${totalCost.toFixed(4)}`);
    console.log(`  Average Cost: $${(totalCost / files.length).toFixed(4)}`);
    console.log(`  Total Tokens: ${totalTokens.toLocaleString()}`);

    console.log(chalk.green('\n🏁 Exit Status Distribution:'));
    Object.entries(exitStatuses)
      .sort((a, b) => b[1] - a[1])
      .forEach(([status, count]) => {
        const percentage = ((count / files.length) * 100).toFixed(1);
        console.log(`  ${status.padEnd(20)} ${count.toString().padStart(5)} (${percentage}%)`);
      });
  });

// Parse arguments
program.parse(process.argv);

// Show help if no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
