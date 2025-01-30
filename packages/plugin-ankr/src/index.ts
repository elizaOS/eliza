import { Plugin } from "@elizaos/core";
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { getConfig } from "./environment";
import { actionGetTokenHoldersCount } from "./actions/actionGetTokenHoldersCount";
import { actionGetTokenPrice } from "./actions/actionGetTokenPrice";
import { actionGetTokenTransfers } from "./actions/actionGetTokenTransfers";
import { actionGetAccountBalance } from "./actions/actionGetAccountBalance";
import { actionGetTransactionsByAddress } from "./actions/actionGetTransactionsByAddress";
import { actionGetTransactionsByHash } from "./actions/actionGetTransactionsByHash";
import { actionGetBlockchainStats } from "./actions/actionGetBlockchainStats";
import { actionGetCurrencies } from "./actions/actionGetCurrencies";
import { actionGetInteractions } from "./actions/actionGetInteractions";
import { actionGetNFTHolders } from "./actions/actionGetNFTHolders";
import { actionGetNFTTransfers } from "./actions/actionGetNFTTransfers";
import { actionGetNFTMetadata } from "./actions/actionGetNFTMetadata";
import { actionGetNFTsByOwner } from "./actions/actionGetNFTsByOwner";



// Start the loader
const spinner = ora({
    text: chalk.cyan('Initializing ANKR Plugin...'),
    spinner: 'dots12',
    color: 'cyan'
  }).start();

const actions = [
    actionGetTokenHoldersCount,
    actionGetTokenPrice,
    actionGetTokenTransfers,
    actionGetAccountBalance,
    actionGetTransactionsByAddress,
    actionGetTransactionsByHash,
    actionGetBlockchainStats,
    actionGetCurrencies,
    actionGetInteractions,
    actionGetNFTHolders,
    actionGetNFTTransfers,
    actionGetNFTMetadata,
    actionGetNFTsByOwner,
];

// Get NVIDIA_NIM_SPASH from config
const ANKR_SPASH = getConfig().ANKR_WALLET;

// Initial banner
// Only show splash screen if NVIDIA_NIM_SPASH is true
if (ANKR_SPASH) {
    // Initial banner with chalk styling
    console.log(`\n${chalk.cyan('┌────────────────────────────────────────┐')}`);
    console.log(chalk.cyan('│') + chalk.yellow.bold('          ANKR PLUGIN             ') + chalk.cyan(' │'));
    console.log(chalk.cyan('├────────────────────────────────────────┤'));
    console.log(chalk.cyan('│') + chalk.white('  Initializing ANKR Services...    ') + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.white('  Version: 1.0.0                        ') + chalk.cyan('│'));
    console.log(chalk.cyan('└────────────────────────────────────────┘'));

    // Stop the loader
    spinner.succeed(chalk.green('ANKR Plugin initialized successfully!'));

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
      [chalk.white('Name    : ') + chalk.yellow('plugin-ankr')],
      [chalk.white('Actions : ') + chalk.green(actions.length.toString())],
      [chalk.white('Status  : ') + chalk.green('Loaded & Ready')]
    );

    console.log(`\n${statusTable.toString()}\n`);
  } else {
    // Stop the loader silently if splash is disabled
    spinner.stop();
  }

  const ankrPlugin: Plugin = {
    name: "plugin-ankr",
    description: "Ankr Plugin for web3",
    actions: actions,
    evaluators: []
  };

export { ankrPlugin };
export default ankrPlugin;
