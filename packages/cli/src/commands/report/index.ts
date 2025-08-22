/**
 * Report Command Registration
 *
 * This module registers the top-level 'report' command and all its subcommands
 * with the ElizaOS CLI system. The report command provides tools for analyzing
 * and generating insights from scenario matrix execution data.
 *
 * Required by ticket #5787 - CLI Command Registration.
 */

import { Command } from 'commander';
import { createGenerateCommand } from './generate';

/**
 * Main 'report' command with all subcommands
 */
export const report = new Command('report')
  .description('Generate and analyze reports from scenario matrix runs')
  .addHelpText(
    'after',
    `
Examples:
  $ elizaos report generate ./output/matrix-20231027-1000/
  $ elizaos report generate ./output/matrix-20231027-1000/ --output-path ./reports/latest.json

The report command analyzes raw JSON outputs from scenario matrix runs and generates
comprehensive performance reports with statistics, parameter comparisons, and trajectory analysis.
  `
  )
  .addCommand(createGenerateCommand());

// Export the main command for registration with the CLI
export default report;
