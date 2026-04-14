import { createContext, useContext } from "react";
import {
  DEFAULT_BOOT_CONFIG,
  type AppBootConfig,
} from "./boot-config-store.js";

export const AppBootContext = createContext<AppBootConfig>(DEFAULT_BOOT_CONFIG);

/** Read the boot config from a React component. */
export function useBootConfig(): AppBootConfig {
  return useContext(AppBootContext);
}
