import { createContext, useContext } from "react";
import type { SystemProvider } from "../types";

export const SystemProviderContext = createContext<SystemProvider | null>(null);

export function useSystemProvider(): SystemProvider {
  const ctx = useContext(SystemProviderContext);
  if (!ctx) {
    throw new Error(
      "useSystemProvider must be used inside a SystemProvider context (MockSystemProvider or LinuxSystemProvider).",
    );
  }
  return ctx;
}
