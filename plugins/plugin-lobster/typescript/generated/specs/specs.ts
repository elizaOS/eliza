/**
 * Action specs for plugin-lobster
 */

export interface ActionSpec {
  name: string;
  description: string;
  similes?: string[];
  examples?: Array<Array<{ role: string; content: string }>>;
}

export const actionSpecs: Record<string, ActionSpec> = {
  LOBSTER_RUN: {
    name: "LOBSTER_RUN",
    description:
      "Run a Lobster pipeline for deterministic, multi-step workflows with approval checkpoints. Use for repeatable automations like email triage, PR monitoring, or scheduled tasks.",
    similes: [
      "RUN_PIPELINE",
      "EXECUTE_WORKFLOW",
      "START_AUTOMATION",
      "RUN_LOBSTER",
      "PIPELINE_RUN",
    ],
    examples: [
      [
        {
          role: "user",
          content: "Triage my email from the last day",
        },
        {
          role: "assistant",
          content:
            "Running the email triage pipeline to process your recent emails and categorize them.",
        },
      ],
      [
        {
          role: "user",
          content: "Run the PR review workflow on this repository",
        },
        {
          role: "assistant",
          content:
            "Starting the PR review pipeline. It will analyze open PRs and prepare review summaries.",
        },
      ],
    ],
  },

  LOBSTER_RESUME: {
    name: "LOBSTER_RESUME",
    description:
      "Resume a paused Lobster pipeline after an approval checkpoint. Use when a pipeline returned needs_approval status and the user has decided whether to proceed.",
    similes: [
      "APPROVE_WORKFLOW",
      "CONTINUE_PIPELINE",
      "RESUME_AUTOMATION",
      "APPROVE_ACTION",
      "WORKFLOW_CONTINUE",
    ],
    examples: [
      [
        {
          role: "user",
          content: "Yes, go ahead and send those draft replies",
        },
        {
          role: "assistant",
          content: "Resuming the pipeline with approval. The draft replies will now be sent.",
        },
      ],
      [
        {
          role: "user",
          content: "No, cancel the deployment",
        },
        {
          role: "assistant",
          content: "Resuming the pipeline with rejection. The deployment has been cancelled.",
        },
      ],
    ],
  },
};

export function requireActionSpec(name: string): ActionSpec {
  const spec = actionSpecs[name];
  if (!spec) {
    throw new Error(`Action spec not found: ${name}`);
  }
  return spec;
}
