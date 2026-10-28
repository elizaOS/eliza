/**
 * Presentation of a typed phone workflow's reviewed trigger. Typed workflows
 * (authored through `/api/workflow/phone/*`) carry their own trigger in the
 * reviewed specification: a local-time schedule is armed per reviewed version
 * on the agent's durable scheduler, and generic triggers cannot start them (the
 * agent refuses any trigger or schedule admission that is not an exact
 * occurrence of the reviewed time).
 */
import {
  describePhoneWorkflowTrigger,
  validatePhoneWorkflowSpec,
} from "@elizaos/contracts/phone-workflow";

/** plugin-workflow `PHONE_SPEC_KEY`: the reviewed typed specification. */
const TYPED_SPEC_KEY = "elizaPhoneWorkflowSpec";
/** plugin-workflow `HOSTED_SPEC`: hosted digests keep their own reviewed schedule. */
const HOSTED_DIGEST_KEY = "elizaHostedDigestV1";

export interface TypedWorkflowSchedule {
  /** The reviewed trigger is a local-time schedule. */
  scheduled: boolean;
  /** Owner-facing statement of when the workflow runs. */
  summary: string;
}

/** The reviewed trigger of a typed phone workflow, or null for any other workflow. */
export function typedWorkflowSchedule(
  metadata: Record<string, unknown> | undefined,
): TypedWorkflowSchedule | null {
  const raw = metadata?.[TYPED_SPEC_KEY];
  if (typeof raw !== "string" || metadata?.[HOSTED_DIGEST_KEY] !== undefined)
    return null;
  let trigger: ReturnType<typeof validatePhoneWorkflowSpec>["trigger"];
  try {
    trigger = validatePhoneWorkflowSpec(JSON.parse(raw)).trigger;
  } catch {
    return {
      scheduled: false,
      summary:
        "This typed workflow's trigger could not be read. It runs only when started explicitly.",
    };
  }
  if (trigger.kind === "manual")
    return {
      scheduled: false,
      summary: "Runs only when started explicitly. It has no schedule.",
    };
  return {
    scheduled: true,
    summary: `${describePhoneWorkflowTrigger(trigger)}, only while this agent is running. A time missed while it is off is recorded as missed and never run later. Turning it on applies to the version shown.`,
  };
}
