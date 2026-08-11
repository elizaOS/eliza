/**
 * Compatibility export for the shared speaker-name inference policy.
 *
 * Runtime and action consumers historically imported this plugin-local path;
 * the implementation now lives in @elizaos/shared so meeting capture and the
 * voice-profile owner evaluate the same dependency-free policy.
 */

export {
	type ExistingSpeakerEntity,
	type InferSpeakerNameInput,
	inferSpeakerName,
	type SpeakerNameBindingAction,
	type SpeakerNameBindingPlan,
	type SpeakerNameCandidate,
	type SpeakerNameEvidence,
	type SpeakerNameEvidenceSource,
	type SpeakerNameInference,
	type SpeakerNameProvenance,
	type SpeakerNameReasonCode,
	type SpeakerNameResolution,
	type SpeakerNameVoiceTurnBindingPlan,
} from "@elizaos/shared";
