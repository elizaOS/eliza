import { type Action, type IAgentRuntime, type ModelTypeName } from "@elizaos/core";

export interface SuggestionDecision {
  name: string;
  known: {},
  unknown: string[]
}

interface PromptParams {
  address: `0x${string}`;
  chainId: number;
  conversation: string;
  decision: SuggestionDecision;
}

export interface Suggestion {
  name: string;
  description: string;
  getPrompt: (runtime: IAgentRuntime, key: PromptParams) => Promise<string>;
  model?: ModelTypeName;
}


export interface ActionModule {
  action: Action;
  suggest: Suggestion[];
}
