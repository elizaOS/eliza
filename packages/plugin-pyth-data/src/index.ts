import type { Plugin } from "@elizaos/core";
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import getPriceFeedsAction from "./actions/actionGetPriceFeeds";
import getPriceUpdatesStreamAction from "./actions/actionGetPriceUpdatesStream";
import getLatestPriceUpdatesAction from "./actions/actionGetLatestPriceUpdates";
import getLatestPublisherCapsAction from "./actions/actionGetLatestPublisherCaps";

// Start the loader
const spinner = ora({
  text: chalk.cyan('Initializing Pyth Data Plugin...'),
  spinner: 'dots12',
  color: 'cyan'
}).start();

// Simulate some loading time
await new Promise(resolve => setTimeout(resolve, 1000));

const actions = [
  getPriceFeedsAction,
  getPriceUpdatesStreamAction,
  getLatestPriceUpdatesAction,
  getLatestPublisherCapsAction,
];

// Initial banner with chalk styling
console.log('\n' + chalk.cyan('┌────────────────────────────────────────┐'));
console.log(chalk.cyan('│') + chalk.yellow.bold('          PYTH DATA PLUGIN             ') + chalk.cyan(' │'));
console.log(chalk.cyan('├────────────────────────────────────────┤'));
console.log(chalk.cyan('│') + chalk.white('  Initializing Pyth Data Services...    ') + chalk.cyan('│'));
console.log(chalk.cyan('│') + chalk.white('  Version: 1.0.0                        ') + chalk.cyan('│'));
console.log(chalk.cyan('└────────────────────────────────────────┘'));

// Stop the loader
spinner.succeed(chalk.green('Pyth Data Plugin initialized successfully!'));

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
  [chalk.white('Name    : ') + chalk.yellow('pyth-data')],
  [chalk.white('Actions : ') + chalk.green(actions.length.toString())],
  [chalk.white('Status  : ') + chalk.green('Loaded & Ready')]
);

console.log('\n' + statusTable.toString() + '\n');

const pythDataPlugin: Plugin = {
  name: "pyth-data",
  description: "Pyth Data Plugin for price feeds and market data",
  actions: actions,
  evaluators: []
};

// Export for both CommonJS and ESM
export { pythDataPlugin };
export default pythDataPlugin;
