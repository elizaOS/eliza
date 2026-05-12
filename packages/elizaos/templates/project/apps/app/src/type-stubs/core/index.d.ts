export type UUID = string;

export interface Content {
  [key: string]: unknown;
}

export interface Memory {
  id?: UUID;
  content: Content;
  [key: string]: unknown;
}

export interface Plugin {
  [key: string]: unknown;
}

export class AgentRuntime {
  constructor(...args: unknown[]);
}
