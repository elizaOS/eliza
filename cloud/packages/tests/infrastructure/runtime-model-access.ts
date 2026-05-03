/**
 * Runtime message tests call the live OpenRouter provider via runtime.useModel().
 * Skip those suites unless the runtime has the credentials it actually uses.
 */

export const hasRuntimeModelCredentials = Boolean(process.env.OPENROUTER_API_KEY);
