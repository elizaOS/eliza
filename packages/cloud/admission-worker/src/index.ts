/** Dedicated isolate boundary; the canonical gate owns every persisted state transition. */
export { InferenceAdmissionGate } from "../../api/src/inference-admission-gate";

// No public admission or accounting endpoint. Callers use the existing DO binding.
export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
