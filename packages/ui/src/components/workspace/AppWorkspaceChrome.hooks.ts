import { createContext, useContext } from "react";

export interface AppWorkspaceChatChromeContextValue {
  collapseChat: () => void;
  openChat: () => void;
  isChatOpen: boolean;
}

export const AppWorkspaceChatChromeContext =
  createContext<AppWorkspaceChatChromeContextValue | null>(null);

export function useAppWorkspaceChatChrome(): AppWorkspaceChatChromeContextValue | null {
  return useContext(AppWorkspaceChatChromeContext);
}
