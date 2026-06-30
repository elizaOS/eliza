declare module "@elizaos/agent/services/agent-export" {
  export interface ImportResult {
    success: boolean;
    agentId: string;
    agentName: string;
    counts: {
      memories: number;
      entities: number;
      components: number;
      rooms: number;
      participants: number;
      relationships: number;
      worlds: number;
      tasks: number;
      logs: number;
      media: number;
    };
  }

  export function importAgent(
    runtime: unknown,
    archive: Buffer | Uint8Array,
    password: string,
  ): Promise<ImportResult>;
}
