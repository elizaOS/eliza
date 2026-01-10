import { Plugin } from '@elizaos/core';
import { ShellService } from './services/shellService';
import { executeCommand, clearHistory } from './actions';
import { shellHistoryProvider } from './providers';

export const shellPlugin: Plugin = {
  name: 'shell',
  description: 'Execute shell commands within a restricted directory with history tracking',
  services: [ShellService],
  actions: [executeCommand, clearHistory],
  providers: [shellHistoryProvider],
};

export default shellPlugin;

// Export types and utilities for external use
export { type CommandResult, ShellService } from './services/shellService';
export { executeCommand } from './actions/executeCommand';
export { type ShellConfig, loadShellConfig } from './environment'; 