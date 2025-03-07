export * from "./services/index.ts";

import type { Plugin } from "@elizaos/core";

import {
	AwsS3Service,
	BrowserService,
	PdfService,
	VideoService,
} from "./services/index.ts";

export const nodePlugin: Plugin = {
	name: "default",
	description: "Default plugin, with basic actions and evaluators",
	services: [BrowserService, PdfService, VideoService, AwsS3Service],
	actions: [],
};
