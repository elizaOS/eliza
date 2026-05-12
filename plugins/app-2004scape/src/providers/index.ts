export { botStateProvider } from "./bot-state.js";
export { goalsProvider } from "./goals.js";
export { mapAreaProvider } from "./map-area.js";
export { worldKnowledgeProvider } from "./world-knowledge.js";

import { botStateProvider } from "./bot-state.js";
import { goalsProvider } from "./goals.js";
import { mapAreaProvider } from "./map-area.js";
import { worldKnowledgeProvider } from "./world-knowledge.js";

export const rsSdkProviders = [
  mapAreaProvider,
  worldKnowledgeProvider,
  goalsProvider,
  botStateProvider,
];
