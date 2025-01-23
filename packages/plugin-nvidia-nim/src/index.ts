import { Plugin } from "@elizaos/core";
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { getConfig } from "./environment";
import getTopicAction from "./actions/actionGetTopic";
import getSafetyAction from "./actions/actionGetSafety";
import getJailBreakAction from "./actions/actionGetJailBreak";
import getCosmosDescriptionAction from "./actions/actionGetCosmos";
import getDeepFakeAction from "./actions/actionGetDeepFake";
import getAIImageAction from "./actions/actionGetAIImage";

// Start the loader
const spinner = ora({
  text: chalk.cyan('Initializing NVIDIA NIM Plugin...'),
  spinner: 'dots12',
  color: 'cyan'
}).start();

const actions = [
  getTopicAction,
  getSafetyAction,
  getJailBreakAction,
  getCosmosDescriptionAction,
  getDeepFakeAction,
  getAIImageAction
];

// Get NVIDIA_NIM_SPASH from config
const NVIDIA_NIM_SPASH = getConfig().NVIDIA_NIM_SPASH;

// Only show splash screen if NVIDIA_NIM_SPASH is true
if (NVIDIA_NIM_SPASH) {
  // Initial banner with chalk styling
  console.log('\n' + chalk.cyan('┌────────────────────────────────────────┐'));
  console.log(chalk.cyan('│') + chalk.yellow.bold('          NVIDIA NIM PLUGIN             ') + chalk.cyan(' │'));
  console.log(chalk.cyan('├────────────────────────────────────────┤'));
  console.log(chalk.cyan('│') + chalk.white('  Initializing NVIDIA NIM Services...    ') + chalk.cyan('│'));
  console.log(chalk.cyan('│') + chalk.white('  Version: 1.0.0                        ') + chalk.cyan('│'));
  console.log(chalk.cyan('└────────────────────────────────────────┘'));

  // Stop the loader
  spinner.succeed(chalk.green('NVIDIA NIM Plugin initialized successfully!'));

  // Create a beautiful table for actions
  const actionTable = new Table({
    head: [
      chalk.cyan('Action'),
      chalk.cyan('H'),
      chalk.cyan('V'),
      chalk.cyan('E'),
      chalk.cyan('Similes')
    ],
    style: {
      head: [],
      border: ['cyan']
    }
  });

  // Format and add action information
  actions.forEach(action => {
    actionTable.push([
      chalk.white(action.name),
      typeof action.handler === 'function' ? chalk.green('✓') : chalk.red('✗'),
      typeof action.validate === 'function' ? chalk.green('✓') : chalk.red('✗'),
      action.examples?.length > 0 ? chalk.green('✓') : chalk.red('✗'),
      chalk.gray(action.similes?.join(', ') || 'none')
    ]);
  });

  // Display the action table
  console.log('\n' + actionTable.toString());

  // Plugin status with a nice table
  const statusTable = new Table({
    style: {
      border: ['cyan']
    }
  });

  statusTable.push(
    [chalk.cyan('Plugin Status')],
    [chalk.white('Name    : ') + chalk.yellow('nvidia-nim')],
    [chalk.white('Actions : ') + chalk.green(actions.length.toString())],
    [chalk.white('Status  : ') + chalk.green('Loaded & Ready')]
  );

  console.log('\n' + statusTable.toString() + '\n');
} else {
  // Stop the loader silently if splash is disabled
  spinner.stop();
}

const nvidiaNimPlugin: Plugin = {
  name: "nvidia-nim",
  description: "NVIDIA NIM Plugin for AI Foundation Models integration",
  actions: actions,
  evaluators: []
};

// Export for both CommonJS and ESM
export { nvidiaNimPlugin };
export default nvidiaNimPlugin;
