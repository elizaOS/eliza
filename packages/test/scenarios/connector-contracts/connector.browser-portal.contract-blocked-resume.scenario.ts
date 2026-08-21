/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.browser-portal.contract-blocked-resume",
  title: "Exercise simulated browser blocked-resume intervention handling",
  connector: "browser-portal",
  axis: "blocked-resume",
  description:
    "Simulated connector contract for browser portal work that gets blocked and must resume with human help instead of silently failing or falsely claiming completion.",
  seed: [
    {
      type: "connectorStatus",
      connector: "browser-portal",
      provider: "Browser bridge",
      state: "blocked-resume",
    },
  ],
  turns: [
    {
      name: "browser-portal-blocked-resume",
      // The prompt never names the seeded block; the agent must discover it
      // mid-flow and report what it needs in its own words.
      text: "Upload the file through the portal and see it through to the end. If anything stands in the way, tell me what you need from me rather than pretending it finished.",
      responseIncludesAny: [
        "blocked",
        "stuck",
        "intervention",
        "waiting on you",
      ],
      expectedActions: ["COMPUTER_USE", "AUTOFILL"],
      actionPayloadIncludesAny: ["portal", "blocked", "help", "resume"],
    },
  ],
  finalChecks: [
    { type: "browserTaskNeedsHuman", expected: true },
    { type: "interventionRequestExists", expected: true },
    {
      type: "connectorDispatchOccurred",
      channel: "browser-portal",
      turn: "browser-portal-blocked-resume",
      expected: false,
      maxCount: 0,
    },
  ],
});
