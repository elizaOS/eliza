// spec/cloud/services/speech.md, "Story: Speak a reply as audio"
import { Schema } from "effect";

const spoken = (minimum: number) => Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(5000));

export const SynthesisBody = Schema.Struct({
  text: spoken(1),
  previousText: Schema.optionalKey(spoken(0)),
  nextText: Schema.optionalKey(spoken(0)),
  voiceId: Schema.optionalKey(Schema.String),
  modelId: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.Literals(["mp3", "wav"])),
  speed: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0.7, maximum: 1.2 }))),
  applyTextNormalization: Schema.optionalKey(Schema.Literals(["auto", "off"])),
  withTimestamps: Schema.optionalKey(Schema.Boolean),
});
export type SynthesisBody = typeof SynthesisBody.Type;
