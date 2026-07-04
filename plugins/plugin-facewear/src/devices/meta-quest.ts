/**
 * Meta Quest device constants describe supported headset identifiers and WebXR
 * feature requirements.
 */
export { DEVICE_REGISTRY } from "./registry.ts";
export const META_QUEST_WEBXR_FEATURES = [
  "hand-tracking",
  "hit-test",
  "local-floor",
  "bounded-floor",
  "layers",
  "depth-sensing",
];
export const META_QUEST_DEVICE_TYPES = [
  "quest3",
  "quest3s",
  "questpro",
  "quest2",
] as const;
export type MetaQuestDeviceType = (typeof META_QUEST_DEVICE_TYPES)[number];
