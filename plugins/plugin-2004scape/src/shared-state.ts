/**
 * Module-level pass-through for the current LLM response text.
 * The autonomous loop stores the response before dispatching parsed actions,
 * so action handlers can parse parameters from it.
 */
let currentLlmResponse = "";

export function setCurrentLlmResponse(text: string): void {
  currentLlmResponse = text;
}

export function getCurrentLlmResponse(): string {
  return currentLlmResponse;
}
