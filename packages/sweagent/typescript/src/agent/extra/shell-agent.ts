/**
 * ShellAgent - A shell-based agent implementation
 * 
 * This agent type executes commands in a shell environment.
 */

import { DefaultAgent, type DefaultAgentConfig } from "../agents";

/**
 * ShellAgent extends DefaultAgent with shell-specific functionality.
 * Currently delegates to DefaultAgent implementation.
 */
export class ShellAgent extends DefaultAgent {
  static override fromConfig(config: DefaultAgentConfig): ShellAgent {
    // Use the DefaultAgent.fromConfig and cast to ShellAgent
    const agent = DefaultAgent.fromConfig(config);
    // Return as ShellAgent (they share the same interface)
    return agent as unknown as ShellAgent;
  }
}
