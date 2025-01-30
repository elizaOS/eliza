import { Plugin} from "@elizaos/core";
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { getConfig } from "./environment";
import { createDeploymentAction } from "./actions/createDeployment";
import { closeDeploymentAction } from "./actions/closeDeployment";
import { getProviderInfoAction } from "./actions/getProviderInfo";
import { getDeploymentStatusAction } from "./actions/getDeploymentStatus";
import { estimateGas } from "./actions/estimateGas";
import { getDeploymentApiAction } from "./actions/getDeploymentApi";
import { getGPUPricingAction } from "./actions/getGPUPricing";
import { getManifestAction } from "./actions/getManifest";
import { getProvidersListAction } from "./actions/getProvidersList";


// Start the loader
const spinner = ora({
  text: chalk.cyan('Initializing Akash Network Plugin...'),
  spinner: 'dots12',
  color: 'cyan'
}).start();

const actions = [
  createDeploymentAction,
  closeDeploymentAction,
  getProviderInfoAction,
  getDeploymentStatusAction,
  estimateGas,
  getDeploymentApiAction,
  getGPUPricingAction,
  getManifestAction,
  getProvidersListAction,
];

const AKASH_SPASH = getConfig().AKASH_WALLET_ADDRESS;

// Initial banner
// Only show splash screen if AKASH_SPASH is true
if (AKASH_SPASH) {
    // Initial banner with chalk styling
    console.log(`\n${chalk.cyan('┌────────────────────────────────────────┐')}`);
    console.log(chalk.cyan('│') + chalk.yellow.bold('          AKASH NETWORK PLUGIN           ') + chalk.cyan(' │'));
    console.log(chalk.cyan('├────────────────────────────────────────┤'));
    console.log(chalk.cyan('│') + chalk.white('  Initializing Akash Network Plugin...   ') + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.white('  Version: 0.1.1                         ') + chalk.cyan('│'));
    console.log(chalk.cyan('└────────────────────────────────────────┘'));

    // Stop the loader
    spinner.succeed(chalk.green('Akash Network Plugin initialized successfully!'));

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
      [chalk.white('Name    : ') + chalk.yellow('plugin-akash')],
      [chalk.white('Actions : ') + chalk.green(actions.length.toString())],
      [chalk.white('Status  : ') + chalk.green('Loaded & Ready')]
    );

    console.log(`\n${statusTable.toString()}\n`);
  } else {
    // Stop the loader silently if splash is disabled
    spinner.stop();
  }

  const akashPlugin: Plugin = {
    name: "plugin-akash",
    description: "Akash Network Plugin for deploying and managing cloud compute",
    actions: actions,
    evaluators: []
  };

export { akashPlugin };
export default akashPlugin;
