import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "acquisition-dataroom-cleanup",
  title: "Assistant cleans up acquisition dataroom access",
  domain: "executive.documents",
  tags: ["lifeops", "executive-assistant", "documents", "privacy", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Acquisition Dataroom Cleanup",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "audit-dataroom-access",
      text: "The acquisition process ended. Audit dataroom access, downloaded-document exceptions, advisor accounts, NDA survival terms, and files to archive.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "privacy", "owner_send_message"],
      responseIncludesAny: ["dataroom", "advisor", "NDA", "archive"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-dataroom-revocation",
      text: "Prepare revocation notices and an archive checklist. Hold external notices until legal confirms the closeout language.",
      plannerIncludesAny: ["approval", "owner_send_message", "SCHEDULED_TASKS"],
      responseIncludesAny: ["revocation", "archive", "legal", "closeout"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
