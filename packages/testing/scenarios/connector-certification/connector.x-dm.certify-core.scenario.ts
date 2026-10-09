/** Scenario fixture for connector x dm certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.x-dm.certify-core",
  title: "Certify X DM inbox reads and response drafting",
  connector: "x-dm",
  axis: "core",
  description:
    "Connector certification for X DM reads, response drafting, and message-context handling through the X surface.",
  turns: [
    {
      name: "x-dm-core",
      text: "Read my unread X DMs and draft the right reply with the right context.",
      // Draft-completion tokens the prompt never uses; parroting "draft the
      // right reply" cannot satisfy any of them.
      responseIncludesAny: [
        "drafted",
        "composed",
        "ready to send",
        "proposed reply",
      ],
      expectedActions: ["X_READ", "INBOX"],
      actionPayloadIncludesAny: ["x", "dm", "reply", "draft"],
    },
  ],
  finalChecks: [{ type: "draftExists", channel: "x-dm", expected: true }],
});
