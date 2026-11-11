/** Run source conformance for the associated container model. */
import { runContainerConformance } from "./container-conformance.mjs";

await runContainerConformance(
  "quint-container-monitor",
  [
    {
      file: "packages/cloud/shared/src/lib/services/__tests__/container-health-observation.pglite.test.ts",
      names: [
        "records a current healthy observation",
        "records a current stopped-runtime observation",
        "a starting runtime leaves the current deployment pending",
        "a failed health request leaves the current deployment pending",
        "a pending retirement cannot be undone by an older healthy probe",
        "completed deletion cannot be resurrected by an older healthy probe",
        "an older failed probe cannot overwrite a newer deploying generation",
        "metadata-only placement changes advance the canonical revision",
        "status ABA cannot validate an older observation",
        "a recreated row with the same millisecond cannot accept the original row probe",
        "placement metadata ABA cannot validate an older observation",
        "bookkeeping metadata keeps its revision but still invalidates a sampled snapshot",
      ],
    },
  ],
  false,
);
