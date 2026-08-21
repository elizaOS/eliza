/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.imessage.contract-helper-disconnected",
  title: "Exercise simulated iMessage helper-disconnected degradation handling",
  connector: "imessage",
  axis: "helper-disconnected",
  description:
    "Simulated connector contract for iMessage when the Mac-side helper is disconnected. The assistant must surface the helper outage instead of pretending the bridge is healthy.",
  seed: [
    {
      type: "connectorStatus",
      connector: "imessage",
      provider: "BlueBubbles / Blooio",
      state: "helper-disconnected",
    },
  ],
  turns: [
    {
      name: "imessage-helper-disconnected",
      // The prompt never names the seeded failure; the agent must discover the
      // Mac-side helper outage from the connector itself and report it.
      text: "Use the iMessage bridge to read the thread and get my reply out. Level with me about anything standing in the way before you claim success.",
      responseIncludesAny: [
        "helper",
        "disconnected",
        "bluebubbles",
        "reconnect",
      ],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: [
        "imessage",
        "helper",
        "disconnected",
        "repair",
      ],
    },
  ],
  finalChecks: [
    { type: "interventionRequestExists", expected: true },
    {
      type: "connectorDispatchOccurred",
      channel: "imessage",
      turn: "imessage-helper-disconnected",
      expected: false,
      maxCount: 0,
    },
  ],
});
