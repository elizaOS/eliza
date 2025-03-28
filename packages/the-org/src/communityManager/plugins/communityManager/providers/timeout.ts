import { addHeader } from '@elizaos/core';
import type { Provider } from '@elizaos/core';

/**
 * Provider that produces a prompt to help the agent decide if someone should be timed out.
 * It does not analyze history directly — another provider must supply the conversation context.
 * This provider simply provides a high-level prompt instructing the agent to take the TIMEOUT_USER action if needed.
 */
export const timeoutUserProvider: Provider = {
  name: 'TIMEOUT_USER_CONTEXT',
  description: 'Prompt to decide if someone in the conversation should be timed out.',
  get: async () => {
    const instruction = `Review the conversation carefully.

If any user is:
- Spreading FUD
- Being toxic or disrespectful
- Using violent, hateful, or abusive language
- Clearly violating community guidelines

Then you **must** select the TIMEOUT_USER action and return the username of the person who should be timed out.

only return the action if:
- You are confident someone broke the rules, **and**
- That person has **not already been punished**.
`;

    return {
      data: {},
      values: {
        moderation: addHeader('# Timeout Decision Instructions', instruction),
      },
      text: addHeader('# Timeout Decision Instructions', instruction),
    };
  },
};
