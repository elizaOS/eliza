// Browser-pure stand-in for usePromptSuggestions in the e2e bundle. The real
// hook reaches the API client (which drags in Node-only deps at bundle time and
// only matters for the small-model fetch). The harness just needs the static
// strip, so return three fixed prompts.
export function usePromptSuggestions(): string[] {
  return [
    "what's on my plate today?",
    "summarize this view",
    "draft a quick note",
  ];
}
