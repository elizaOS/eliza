import type { Plugin } from "@elizaos/core";
import { cancelFormAction } from "./actions/cancel-form";
import { createFormAction } from "./actions/create-form";
import { updateFormAction } from "./actions/update-form";
import { formsProvider } from "./providers/forms-provider";
import { formsSchema } from "./schema";
import { FormsService } from "./services/forms-service";
import { FormsPluginTestSuite } from "./tests";

export * from "./types";
export { FormsService };
export { formsProvider };
export { createFormAction, updateFormAction, cancelFormAction };
export { formsSchema };

export const formsPlugin: Plugin = {
  name: "@elizaos/plugin-forms",
  description: "Structured form collection capabilities for conversational data gathering",

  services: [FormsService],
  providers: [formsProvider],
  actions: [createFormAction, updateFormAction, cancelFormAction],

  schema: formsSchema,
  evaluators: [],
  tests: [FormsPluginTestSuite],
  dependencies: ["@elizaos/plugin-sql"],
  testDependencies: ["@elizaos/plugin-sql"],
};

export default formsPlugin;
