import type { Plugin } from "../../types/index.ts";
import { type IAgentRuntime, logger } from "../../types/index.ts";

import { continueResearchAction } from "./actions/continue-research.ts";
import { createResearchAction } from "./actions/create-research.ts";
import { deleteResearchAction } from "./actions/delete-research.ts";
import { editResearchAction } from "./actions/edit-research.ts";
import { listResearchAction } from "./actions/list-research.ts";
import { readResearchAction } from "./actions/read-research.ts";
import { researchAction } from "./actions/research.ts";
import { researchProvider } from "./providers/research.ts";

export const researchPlugin: Plugin = {
	name: "research",
	description:
		"Per-user research threads. Create, continue, read, list, edit, and delete research inquiries scoped to each user.",

	providers: [researchProvider],

	actions: [
		researchAction,
		createResearchAction,
		continueResearchAction,
		readResearchAction,
		listResearchAction,
		editResearchAction,
		deleteResearchAction,
	],

	async init(
		_config: Record<string, string>,
		_runtime: IAgentRuntime,
	): Promise<void> {
		logger.info("[ResearchPlugin] Initialized");
	},
};

export default researchPlugin;

export { continueResearchAction } from "./actions/continue-research.ts";
export { createResearchAction } from "./actions/create-research.ts";
export { deleteResearchAction } from "./actions/delete-research.ts";
export { editResearchAction } from "./actions/edit-research.ts";
export { listResearchAction } from "./actions/list-research.ts";
export { readResearchAction } from "./actions/read-research.ts";
export { researchAction } from "./actions/research.ts";
export { researchProvider } from "./providers/research.ts";
export {
	getResearchService,
	ResearchService,
} from "./services/researchService.ts";
export type {
	CreateResearchInput,
	ContinueResearchInput,
	EditResearchInput,
	ListResearchOptions,
	Research,
	ResearchFinding,
	ResearchStatus,
} from "./types.ts";
