import { Command } from 'commander';
import { phalaCommand as phala } from './tee/phala';

export const teeCommand = new Command('tee')
  .description('Manage TEE deployments')
  // Add TEE Vendor Commands
  .addCommand(phala);
