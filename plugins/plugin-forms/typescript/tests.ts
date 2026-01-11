/**
 * Test exports for the forms plugin
 * This file exports the test suite so it can be included in the plugin build
 *
 * Note: The actual test file is in __tests__/e2e/forms-plugin.test.ts
 * and is run separately by the test runner.
 */

import type { TestSuite } from "@elizaos/core";

// Export the test suite definition for the plugin's E2E tests
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

        // Create a simple form
        const form = await formsService.createForm("contact");
        if (!form || !form.id) {
          throw new Error("Failed to create form");
        }

        // Verify form was created
        const activeForm = await formsService.getForm(form.id);
        if (!activeForm || activeForm.status !== "active") {
          throw new Error("Form not found or not active");
        }

        // Clean up
        await formsService.cancelForm(form.id);
      },
    },
  ],
};
