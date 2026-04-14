/**
 * Replace un-substituted `{{name}}` / `{{agentName}}` tokens with the
 * actual character name. Handles legacy persisted templates from onboarding.
 */
export function replaceNameTokens(text: string, name: string): string {
  return text
    .replace(/\{\{name\}\}/g, name)
    .replace(/\{\{agentName\}\}/g, name);
}
