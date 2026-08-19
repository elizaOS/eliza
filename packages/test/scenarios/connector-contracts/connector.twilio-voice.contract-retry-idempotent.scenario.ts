/** Proves Twilio voice retries one transient failure with one confirmation-bound idempotency key. */
import { buildVoiceCallDraftContract } from "./_voice-call-draft-contract.ts";
export default buildVoiceCallDraftContract({
  evidenceScope: "connector-contract",
  id: "connector.twilio-voice.contract-retry-idempotent",
  title: "Twilio voice transient retry preserves provider idempotency",
  replay: true,
});
