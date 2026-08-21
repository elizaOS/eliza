/** Proves a confirmed Twilio voice call produces an exact production transport receipt. */
import { buildVoiceCallDraftContract } from "./_voice-call-draft-contract.ts";
export default buildVoiceCallDraftContract({
  evidenceScope: "connector-contract",
  id: "connector.twilio-voice.contract-core",
  title: "Twilio voice confirms then returns an exact provider receipt",
});
