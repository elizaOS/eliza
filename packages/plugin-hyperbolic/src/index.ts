import { Plugin } from "@elizaos/core";
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { getConfig } from "./environment";
import { actionGetAvailableGpus } from "./actions/actionGetAvailableGpus";
import { actionGetCurrentBalance } from "./actions/actionGetCurrentBalance";
import { actionGetGpuStatus } from "./actions/actionGetGpuStatus";
import { actionGetSpendHistory } from "./actions/actionGetSpendHistory";
import { actionRentCompute } from "./actions/actionRentCompute";
import { actionTerminateCompute } from "./actions/actionTerminateCompute";


// Start the loader
const spinner = ora({
    text: chalk.cyan('Initializing HYPERBOLIC Plugin...'),
    spinner: 'dots12',
    color: 'cyan'
  }).start();

const actions = [
    actionGetAvailableGpus,
    actionGetCurrentBalance,
    actionGetGpuStatus,
    actionGetSpendHistory,
    actionRentCompute,
    actionTerminateCompute
];

// Get NVIDIA_NIM_SPASH from config
const HYPERBOLIC_SPASH = getConfig().HYPERBOLIC_SPASH;

// Initial banner
// Only show splash screen if NVIDIA_NIM_SPASH is true
if (HYPERBOLIC_SPASH) {
    // Initial banner with chalk styling
    console.log(`\n${chalk.cyan('┌────────────────────────────────────────┐')}`);
    console.log(chalk.cyan('│') + chalk.yellow.bold('          HYPERBOLIC PLUGIN             ') + chalk.cyan(' │'));
    console.log(chalk.cyan('├────────────────────────────────────────┤'));
    console.log(chalk.cyan('│') + chalk.white('  Initializing HYPERBOLIC Services...    ') + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.white('  Version: 1.0.0                        ') + chalk.cyan('│'));
    console.log(chalk.cyan('└────────────────────────────────────────┘'));

    // Stop the loader
    spinner.succeed(chalk.green('HYPERBOLIC Plugin initialized successfully!'));

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
    for (const action of actions) {
        actionTable.push([
            chalk.white(action.name),
            typeof action.handler === 'function' ? chalk.green('✓') : chalk.red('✗'),
            typeof action.validate === 'function' ? chalk.green('✓') : chalk.red('✗'),
            action.examples?.length > 0 ? chalk.green('✓') : chalk.red('✗'),
            chalk.gray(action.similes?.join(', ') || 'none')
        ]);
    }

    // Display the action table
    console.log(`\n${actionTable.toString()}`);

    // Plugin status with a nice table
    const statusTable = new Table({
      style: {
        border: ['cyan']
      }
    });

    statusTable.push(
      [chalk.cyan('Plugin Status')],
      [chalk.white('Name    : ') + chalk.yellow('hyperbolic-plugin')],
      [chalk.white('Actions : ') + chalk.green(actions.length.toString())],
      [chalk.white('Status  : ') + chalk.green('Loaded & Ready')]
    );

    console.log(`\n${statusTable.toString()}\n`);
  } else {
    // Stop the loader silently if splash is disabled
    spinner.stop();
  }

  const hyperbolicPlugin: Plugin = {
    name: "hyperbolic-plugin",
    description: "HYPERBOLIC Plugin for DePin",
    actions: actions,
    evaluators: []
  };

export { hyperbolicPlugin };
export default hyperbolicPlugin;
