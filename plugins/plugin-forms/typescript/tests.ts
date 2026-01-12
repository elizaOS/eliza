import type { TestSuite } from "@elizaos/core";

export const FormsPluginTestSuite: TestSuite = {
  name: "Forms Plugin Test Suite",
  tests: [
    {
      name: "Create and complete a basic form",
      fn: async (runtime) => {
        const { FormsService } = await import("./services/forms-service.js");
        const formsService = runtime.getService<InstanceType<typeof FormsService>>("forms");
        if (!formsService) {
          throw new Error("Forms service not available");
        }

        const form = await formsService.createForm("contact");
        if (!form || !form.id) {
          throw new Error("Failed to create form");
        }

        const activeForm = await formsService.getForm(form.id);
        if (!activeForm || activeForm.status !== "active") {
          throw new Error("Form not found or not active");
        }

        await formsService.cancelForm(form.id);
      },
    },
  ],
};
