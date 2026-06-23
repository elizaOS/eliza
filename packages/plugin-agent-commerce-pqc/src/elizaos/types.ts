export interface Memory {
  id?: string;
  content: { text: string; [key: string]: unknown };
  roomId: string;
  userId: string;
  agentId: string;
}

export interface State {
  [key: string]: unknown;
  activeJobs?: JobSummary[];
  recentJobId?: string;
}

export interface JobSummary {
  jobId: string;
  status: string;
  clientAgent: string;
  providerAgent: string;
  taskDescription: string;
}

export interface HandlerCallback {
  (response: { text: string; data?: unknown }): Promise<void>;
}

export interface IElizaRuntime {
  agentId: string;
  character: { name: string; plugins?: string[] };
  getSetting(key: string): string | undefined;
  getMemoryManager(): {
    createMemory(memory: Memory): Promise<void>;
    searchMemoriesByEmbedding(embedding: number[], opts: {
      roomId: string; count: number;
    }): Promise<Memory[]>;
  };
}