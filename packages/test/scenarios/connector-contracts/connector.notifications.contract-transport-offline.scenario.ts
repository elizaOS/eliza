/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.notifications.contract-transport-offline",
  title: "Exercise simulated push transport-offline degradation handling",
  connector: "notifications",
  axis: "transport-offline",
  description:
    "Simulated connector contract for desktop/mobile push when the transport is offline. The assistant must surface the failure instead of claiming the device ladder fired.",
  seed: [
    {
      type: "transportFault",
      connector: "notifications",
      provider: "Desktop notification bridge",
      state: "transport-offline",
      limit: 1,
    },
  ],
  turns: [
    {
      name: "notifications-transport-offline",
      // The prompt never names the seeded failure; the agent must discover the
      // dead transport from the dispatch result itself and report it.
      text: "Get that reminder in front of me on my desktop and my phone. If it never actually reaches either device, say so plainly rather than assuming it fired.",
      responseIncludesAny: [
        "offline",
        "transport",
        "unreachable",
        "not deliver",
      ],
      expectedActions: ["DEVICE_INTENT"],
      actionPayloadIncludesAny: ["desktop", "phone", "offline", "push"],
    },
  ],
  finalChecks: [
    { type: "clarificationRequested", expected: true },
    { type: "interventionRequestExists", expected: true },
    {
      type: "connectorDispatchOccurred",
      channel: ["notifications", "desktop", "mobile", "push"],
      turn: "notifications-transport-offline",
      delivered: true,
      expected: false,
      maxCount: 0,
    },
  ],
});
