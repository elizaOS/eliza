import { Command } from 'commander';
import { phalaCliCommand } from './phala-wrapper';

export const teeCommand = new Command('tee')
  .description('Manage TEE deployments')
  // Add TEE Vendor Commands
  .addCommand(phalaCliCommand);
