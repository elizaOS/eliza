/** Owner chat control for school-calendar and monthly packet workflow operations. */

import type {
  Action,
  ActionResult,
  Content,
  ContentValue,
  HandlerOptions,
} from "@elizaos/core";
import { getFamilyWorkflowRuntimeService } from "../lifeops/family-workflows/index.js";

type Operation = "status" | "run_school" | "run_monthly" | "generate_packet";

export const familyWorkflowsAction: Action = {
  name: "FAMILY_WORKFLOWS",
  similes: ["SCHOOL_CALENDAR_WORKFLOW", "FAMILY_COORDINATION_PACKET"],
  description:
    "Configure or run the school-calendar workflow and generate owner-reviewed monthly family coordination packets. Drafts are never sent automatically.",
  validate: async () => true,
  parameters: [
    {
      name: "operation",
      description: "status, run_school, run_monthly, or generate_packet",
      required: true,
      schema: {
        type: "string",
        enum: ["status", "run_school", "run_monthly", "generate_packet"],
      },
    },
  ],
  examples: [],
  handler: async (
    runtime,
    _message,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const service = getFamilyWorkflowRuntimeService(runtime);
    if (!service) {
      const result = {
        success: false,
        text: "Family workflow runtime is unavailable.",
        data: { error: "FAMILY_WORKFLOW_UNAVAILABLE" },
      };
      await callback?.(result);
      return result;
    }
    const operation = ((options as HandlerOptions | undefined)?.parameters
      ?.operation ?? "status") as Operation;
    const data =
      operation === "status"
        ? await service.schoolStatus()
        : operation === "run_school"
          ? await service.runSchool("manual")
          : operation === "run_monthly"
            ? await service.runMonthly("manual")
            : await service.generatePacket();
    // The callback contract uses ContentValue's JSON shape. This round-trip
    // preserves the complete workflow result while proving it is transportable.
    const callbackData = JSON.parse(JSON.stringify(data)) as ContentValue;
    const content: Content = {
      text:
        operation === "status"
          ? "School calendar workflow status loaded."
          : "Family workflow completed without sending any external draft.",
      data: { operation, result: callbackData },
    };
    await callback?.(content);
    return { success: true, ...content };
  },
};
