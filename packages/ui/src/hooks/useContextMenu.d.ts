/**
 * Listens for native desktop context-menu events
 * and dispatches actions into the app state.
 */
import { type SavedCustomCommand } from "../chat";
export type CustomCommand = SavedCustomCommand;
/** Read saved custom commands from localStorage. */
export declare function loadCustomCommands(): CustomCommand[];
export interface ContextMenuState {
  saveCommandModalOpen: boolean;
  saveCommandText: string;
  customCommands: CustomCommand[];
  closeSaveCommandModal: () => void;
  confirmSaveCommand: (name: string) => void;
}
export declare function useContextMenu(): ContextMenuState;
//# sourceMappingURL=useContextMenu.d.ts.map
