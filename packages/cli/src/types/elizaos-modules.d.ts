declare module '@elizaos/server' {
  import type { Character, IAgentRuntime, Plugin } from '@elizaos/core';

  export class AgentServer {
    constructor(runtime?: IAgentRuntime);
    startAgent: (character: Character) => Promise<IAgentRuntime>;
    stopAgent: (runtime: IAgentRuntime) => Promise<void>;
    registerAgent: (runtime: IAgentRuntime) => void;
    unregisterAgent: (agentId: string) => void;
    initialize: (options: { dataDir?: string; postgresUrl?: string }) => Promise<void>;
    loadCharacterTryPath: typeof loadCharacterTryPath;
    jsonToCharacter: typeof jsonToCharacter;
    start(port?: number): Promise<void>;
    stop(): Promise<void>;
  }

  export function loadCharacterTryPath(path: string): Character | null;
  export function jsonToCharacter(json: any): Character;
}

declare module '@elizaos/plugin-sql' {
  import type { Plugin } from '@elizaos/core';

  export const plugin: Plugin;
}
