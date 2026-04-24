export type CharacterHistoryScope = "auto" | "global" | "user";

export type CharacterHistoryValue =
  | string
  | number
  | boolean
  | null
  | CharacterHistoryValue[]
  | { [key: string]: CharacterHistoryValue | undefined };

export interface CharacterHistorySnapshot {
  name?: string;
  username?: string;
  bio?: string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  postExamples?: string[];
  messageExamples?: CharacterHistoryValue[];
}

export interface CharacterHistoryChange {
  field: keyof CharacterHistorySnapshot;
  before?: CharacterHistoryValue;
  after?: CharacterHistoryValue;
}

export interface CharacterHistoryEntry {
  id?: string;
  timestamp: number;
  source: "manual" | "agent" | "restore";
  summary: string;
  fieldsChanged: Array<keyof CharacterHistorySnapshot>;
  changes: CharacterHistoryChange[];
  before: CharacterHistorySnapshot;
  after: CharacterHistorySnapshot;
}

export interface CharacterHistoryResponse {
  history: CharacterHistoryEntry[];
  agentName?: string;
}
