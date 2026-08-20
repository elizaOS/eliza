/** Proves Twilio voice safely retries one explicit not-processed response as one logical operation. */
import { buildVoiceCallDraftContract } from "./_voice-call-draft-contract.ts";
export default buildVoiceCallDraftContract({
  evidenceScope: "connector-contract",
  id: "connector.twilio-voice.contract-retry-idempotent",
  title: "Twilio voice retries only an explicit not-processed response",
  replay: true,
});
