import { createContext, useContext } from "react";

/** The API owner readback for this mounted runtime generation; never a credential. */
export interface AppRuntimeSession {
  readonly authority: string;
  readonly apiBase: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly agentName: string;
}

export type AppRuntimeSessionState =
  | { readonly status: "inactive" }
  | { readonly status: "verifying" }
  | {
      readonly status: "verified";
      readonly session: Readonly<AppRuntimeSession>;
    }
  | { readonly status: "unavailable"; readonly message: string };

export const AppRuntimeSessionContext = createContext<AppRuntimeSessionState>({
  status: "inactive",
});

/** Read-only projection of AppProvider's current authenticated runtime. */
export function useAppRuntimeSession(): AppRuntimeSessionState {
  return useContext(AppRuntimeSessionContext);
}
