import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import type { Project } from "@elizaos/core";
import communityManager from "./communityManager";
import devRel from "./devRel";
import investmentManager from "./investmentManager";
import liaison from "./liaison";
import projectManager from "./projectManager";
import socialMediaManager from "./socialMediaManager";

export const project: Project = {
	agents: [
		// devRel,
		communityManager,
		investmentManager,
		liaison,
		projectManager,
		// socialMediaManager,
	],
};

export default project;