import {
  composePromptFromState,
  logger,
  ModelType,
  ModelTypeName,
  type Content,
  type IAgentRuntime,
  type State,
} from "@elizaos/core";

interface RephraseParams {
  runtime: IAgentRuntime;
  content: Content;
  state: State;
  model?: ModelTypeName;
}

const template = `<task>
Generate dialog for the character {{agentName}}
</task>
<providers>
{{providers}}
</providers>
<initialThought>
{{initialThought}}
</initialThought>
<initialText>
{{initialText}}
</initialText>
<instructions>
Rephrase message for the character {{agentName}} based on the initial text and thought, but in your own words.
Do not include examples of data in your response.
</instructions>
<keys>
- "thought" should be a short description of what the agent is thinking about and planning.
- "message" should be the next message for {{agentName}} which they will send to the conversation, it should NOT be the same as the initial text.
</keys>
<output>
Respond using JSON format like this:
{
  "thought": "<string>",
  "message": "<string>"
}

Your response should include the valid JSON block and nothing else.
</output>`;

/** @deprecated needs refactor */
export const rephrase = async ({ runtime, content, state, model }: RephraseParams) => {
  const {
    actions,
    attachments,
    text: initialText,
    thought: initialThought,
    source,
  } = content;

  // fixme use more efficient way to clone state
  const clonedState = JSON.parse(JSON.stringify(state));
  clonedState.values.initialText = initialText;
  clonedState.values.initialThought = initialThought;

  const prompt = composePromptFromState({
    state: clonedState,
    template,
  });

  const response = await runtime.useModel(model ?? ModelType.OBJECT_SMALL, {
    prompt,
  });

  logger.debug(
    "Rephrase result:",
    JSON.stringify({ initialText, initialThought, response }, null, 2)
  );

  const result: Content = {
    actions,
    attachments,
    text: response.message,
    thought: response.thought,
    source,
  };

  return result;
};
