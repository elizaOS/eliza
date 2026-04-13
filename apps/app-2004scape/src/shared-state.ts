/**
 * Module-level pass-through for the current LLM response text.
 * The runtime monkey-patches processActions to capture the response
 * before action handlers run, so actions can parse parameters from it.
 */
let currentLlmResponse = "";

export function setCurrentLlmResponse(text: string): void {
  currentLlmResponse = text;
}

export function getCurrentLlmResponse(): string {
  return currentLlmResponse;
}
