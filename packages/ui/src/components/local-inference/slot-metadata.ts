import type { AgentModelSlot } from "../../api/client-local-inference";

export type LocalInferenceSlotDescriptor = {
  slot: AgentModelSlot;
  modelType: string;
  label: string;
  description: string;
};

export const LOCAL_INFERENCE_SLOT_DESCRIPTORS: LocalInferenceSlotDescriptor[] =
  [
    {
      slot: "TEXT_SMALL",
      modelType: "TEXT_SMALL",
      label: "Small text",
      description:
        "Short completions, classifications, and background requests.",
    },
    {
      slot: "TEXT_LARGE",
      modelType: "TEXT_LARGE",
      label: "Large text",
      description: "Main chat responses, planning, and reasoning.",
    },
    {
      slot: "TEXT_EMBEDDING",
      modelType: "TEXT_EMBEDDING",
      label: "Embeddings",
      description:
        "Vector search and memory when a local embedding handler exists.",
    },
    {
      slot: "TEXT_TO_SPEECH",
      modelType: "TEXT_TO_SPEECH",
      label: "Voice output",
      description: "Local Eliza-1 TTS for agent speech and voice mode replies.",
    },
    {
      slot: "TRANSCRIPTION",
      modelType: "TRANSCRIPTION",
      label: "Transcription",
      description: "Local Eliza-1 ASR for microphone and voice message input.",
    },
    {
      slot: "IMAGE_DESCRIPTION",
      modelType: "IMAGE_DESCRIPTION",
      label: "Vision",
      description: "Local Eliza-1 image description for screenshots and media.",
    },
  ];
