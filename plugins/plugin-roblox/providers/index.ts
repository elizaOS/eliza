import type { Provider } from "@elizaos/core";
import { gameStateProvider } from "./gameStateProvider";

export const robloxProviders: Provider[] = [gameStateProvider];

export { gameStateProvider };
