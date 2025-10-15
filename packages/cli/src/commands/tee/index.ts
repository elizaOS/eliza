import { Command } from 'commander';
import { phalaCliCommand } from './phala-wrapper';
import { eigenCliCommand } from './eigen-wrapper';

export const teeCommand = new Command('tee')
  .description('Manage TEE deployments')
  .enablePositionalOptions() // Enable for phala's passthrough options
  // Add TEE Vendor Commands
  .addCommand(phalaCliCommand)
  .addCommand(eigenCliCommand);
