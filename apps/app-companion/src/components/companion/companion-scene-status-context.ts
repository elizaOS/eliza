import { createContext, useContext } from "react";

export interface CompanionSceneStatus {
  avatarReady: boolean;
  teleportKey: string;
}

export const CompanionSceneStatusContext = createContext<CompanionSceneStatus>({
  avatarReady: false,
  teleportKey: "",
});

export function useCompanionSceneStatus(): CompanionSceneStatus {
  return useContext(CompanionSceneStatusContext);
}
