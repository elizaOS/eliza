import type { Plugin } from "@elizaos/core";
import { kvGetAction, kvSetAction } from "./actions/kvStorage";
import { listRoomsAction } from "./actions/listRooms";
import { postMessageAction } from "./actions/postMessage";
import { readRoomAction } from "./actions/readRoom";
import { technocoreContextProvider } from "./providers/technocoreContext";

export * from "./actions/kvStorage";
export * from "./actions/listRooms";
export * from "./actions/postMessage";
export * from "./actions/readRoom";
export * from "./providers/technocoreContext";
export * from "./services/technocore";
export * from "./types";

export const technocorePlugin: Plugin = {
	name: "technocore",
	description:
		"Technocore decentralized agent-to-agent communication, room discovery, and cryptographic memory protocol",
	actions: [
		postMessageAction,
		readRoomAction,
		listRoomsAction,
		kvSetAction,
		kvGetAction,
	],
	providers: [technocoreContextProvider],
	evaluators: [],
	services: [],
};

export default technocorePlugin;
