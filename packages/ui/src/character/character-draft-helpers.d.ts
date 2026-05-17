/** Character action helpers — CRUD and draft management. */
import type { CharacterData, ElizaClient } from "../api/client";

type MessageExampleGroup = {
  examples: Array<{
    name: string;
    content: {
      text: string;
    };
  }>;
};
export interface CharacterActionContext {
  client: ElizaClient;
  setCharacterData: (data: CharacterData | null) => void;
  setCharacterDraft: (
    fn: CharacterData | ((prev: CharacterData) => CharacterData),
  ) => void;
  setCharacterLoading: (loading: boolean) => void;
  setCharacterSaving: (saving: boolean) => void;
  setCharacterSaveError: (error: string | null) => void;
  setCharacterSaveSuccess: (message: string | null) => void;
}
export declare function loadCharacter(
  ctx: CharacterActionContext,
): Promise<void>;
export declare function normalizeGeneratedMessageExamples(
  input: unknown,
  fallbackAgentName?: string,
  options?: {
    fallbackMissingSpeaker?: boolean;
  },
): MessageExampleGroup[];
export declare function prepareDraftForSave(
  draft: CharacterData,
  previousName?: string,
): Record<string, unknown>;
export declare function parseMessageExamplesInput(value: string): Array<{
  examples: Array<{
    name: string;
    content: {
      text: string;
    };
  }>;
}>;
export declare function parseArrayInput(value: string): string[];
//# sourceMappingURL=character-draft-helpers.d.ts.map
