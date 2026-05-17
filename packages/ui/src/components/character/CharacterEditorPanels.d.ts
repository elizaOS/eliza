import type { MessageExampleGroup } from "@elizaos/core";
import type { CharacterData } from "../../api/client-types-config";
export interface CharacterIdentityPanelProps {
  bioText: string;
  handleFieldEdit: (field: string, value: unknown) => void;
  t: (
    key: string,
    opts?: {
      defaultValue?: string;
    },
  ) => string;
}
export interface CharacterStylePanelProps {
  d: CharacterData;
  pendingStyleEntries: Record<string, string>;
  styleEntryDrafts: Record<string, string[]>;
  handlePendingStyleEntryChange: (key: string, value: string) => void;
  handleAddStyleEntry: (key: string) => void;
  handleRemoveStyleEntry: (key: string, index: number) => void;
  handleStyleEntryDraftChange: (
    key: string,
    index: number,
    value: string,
  ) => void;
  handleCommitStyleEntry: (key: string, index: number) => void;
  handleReorderStyleEntries: (key: string, items: string[]) => void;
  t: (
    key: string,
    opts?: {
      defaultValue?: string;
    },
  ) => string;
}
export interface CharacterExamplesPanelProps {
  d: CharacterData;
  normalizedMessageExamples: MessageExampleGroup[];
  handleFieldEdit: (field: string, value: unknown) => void;
  t: (
    key: string,
    opts?: {
      defaultValue?: string;
    },
  ) => string;
}
export declare function CharacterIdentityPanel({
  bioText,
  handleFieldEdit,
  t,
}: CharacterIdentityPanelProps): import("react/jsx-runtime").JSX.Element;
export declare function CharacterStylePanel({
  d,
  pendingStyleEntries,
  styleEntryDrafts,
  handlePendingStyleEntryChange,
  handleAddStyleEntry,
  handleRemoveStyleEntry,
  handleStyleEntryDraftChange,
  handleCommitStyleEntry,
  handleReorderStyleEntries,
  t,
}: CharacterStylePanelProps): import("react/jsx-runtime").JSX.Element;
export declare function CharacterExamplesPanel({
  d,
  normalizedMessageExamples,
  handleFieldEdit,
  t,
}: CharacterExamplesPanelProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=CharacterEditorPanels.d.ts.map
