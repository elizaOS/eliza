/** Lean isolate for new speech session objects; the canonical class owns all state. */
export { SpeechRelayCoordinator } from "../../api/src/speech-relay-coordinator";

// No public route. The API reaches sessions through its SPEECH_RELAY_SESSIONS binding.
export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
