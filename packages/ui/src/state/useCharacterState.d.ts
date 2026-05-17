/**
 * Character / avatar state — extracted from AppContext.
 *
 * Manages character data, draft editing, VRM avatar selection, and save
 * callbacks. The handleSaveCharacter callback depends on lifecycle state
 * (agentStatus / setAgentStatus), so those are accepted as params rather
 * than coupling this hook to useLifecycleState directly.
 */
import type { AgentStatus } from "../api";
import { type CharacterData } from "../api";

interface CharacterStateParams {
  agentStatus: AgentStatus | null;
  setAgentStatus: (status: AgentStatus) => void;
}
export declare function useCharacterState({
  agentStatus,
  setAgentStatus,
}: CharacterStateParams): {
  state: {
    characterData: CharacterData | null;
    characterLoading: boolean;
    characterSaving: boolean;
    characterSaveSuccess: string | null;
    characterSaveError: string | null;
    characterDraft: CharacterData;
    selectedVrmIndex: number;
    customVrmUrl: string;
    customVrmPreviewUrl: string;
    customBackgroundUrl: string;
    customCatchphrase: string;
    customVoicePresetId: string;
    activePackId: string | null;
    customWorldUrl: string;
  };
  setCharacterData: import("react").Dispatch<
    import("react").SetStateAction<CharacterData | null>
  >;
  setCharacterDraft: import("react").Dispatch<
    import("react").SetStateAction<CharacterData>
  >;
  setCharacterSaveSuccess: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setCharacterSaveError: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setSelectedVrmIndex: (v: number) => void;
  setCustomVrmUrl: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setCustomVrmPreviewUrl: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setCustomBackgroundUrl: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setCustomCatchphrase: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setCustomVoicePresetId: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setActivePackId: (id: string | null) => void;
  setCustomWorldUrl: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  loadCharacter: () => Promise<void>;
  handleSaveCharacter: () => Promise<void>;
  handleCharacterFieldInput: <K extends keyof CharacterData>(
    field: K,
    value: CharacterData[K],
  ) => void;
  handleCharacterArrayInput: (
    field: "adjectives" | "postExamples",
    value: string,
  ) => void;
  handleCharacterStyleInput: (
    subfield: "all" | "chat" | "post",
    value: string,
  ) => void;
  handleCharacterMessageExamplesInput: (value: string) => void;
};
//# sourceMappingURL=useCharacterState.d.ts.map
