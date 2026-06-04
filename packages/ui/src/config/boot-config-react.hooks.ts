/**
 * Boot config context object + hook. Split from the non-React `boot-config-store`
 * surface so Node-side consumers (bench server, agent boot) can import the store
 * without pulling `react` into their runtime closure.
 */
import { createContext, useContext } from "react";
import {
  type AppBootConfig,
  DEFAULT_BOOT_CONFIG,
} from "./boot-config-store.js";

export const AppBootContext = createContext<AppBootConfig>(DEFAULT_BOOT_CONFIG);

/** Read the boot config from a React component. */
export function useBootConfig(): AppBootConfig {
  return useContext(AppBootContext);
}
