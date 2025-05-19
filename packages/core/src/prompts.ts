/**
 * Convert all double-brace bindings ({{var}}) in a Handlebars template
 * to triple-brace bindings ({{{var}}}), so the output is NOT HTML-escaped.
 *
 * - Ignores block/partial/comment tags that start with # / ! >.
 * - Ignores the {{else}} keyword.
 * - Ignores bindings that are already triple-braced.
 *
 * @param  {string} tpl  Handlebars template source
 * @return {string}      Transformed template
 */
export function upgradeDoubleToTriple(tpl) {
  return tpl.replace(
    // ────────╮ negative-LB: not already “{{{”
    //          │   {{     ─ opening braces
    //          │    ╰──── negative-LA: not {, #, /, !, >
    //          ▼
    /(?<!{){{(?![{#\/!>])([\s\S]*?)}}/g,
    (_match, inner) => {
      // keep the block keyword {{else}} unchanged
      if (inner.trim() === 'else') return `{{${inner}}}`;
      return `{{{${inner}}}}`;
    }
  );
}

/**
 * Composes a context string by replacing placeholders in a template with corresponding values from the state.
 *
 * This function takes a template string with placeholders in the format `{{placeholder}}` and a state object.
 * It replaces each placeholder with the value from the state object that matches the placeholder's name.
 * If a matching key is not found in the state object for a given placeholder, the placeholder is replaced with an empty string.
 *
 * @param {Object} params - The parameters for composing the context.
 * @param {State} params.state - The state object containing values to replace the placeholders in the template.
 * @param {TemplateType} params.template - The template string or function containing placeholders to be replaced with state values.
 * @returns {string} The composed context string with placeholders replaced by corresponding state values.
 *
 * @example
 * // Given a state object and a template
 * const state = { userName: "Alice", userAge: 30 };
 * const template = "Hello, {{userName}}! You are {{userAge}} years old";
 *
 * // Composing the context with simple string replacement will result in:
 * // "Hello, Alice! You are 30 years old."
 * const contextSimple = composePromptFromState({ state, template });
 *
 * // Using composePromptFromState with a template function for dynamic template
 * const template = ({ state }) => {
 * const tone = Math.random() > 0.5 ? "kind" : "rude";
 *   return `Hello, {{userName}}! You are {{userAge}} years old. Be ${tone}`;
 * };
 * const contextSimple = composePromptFromState({ state, template });
 */

/**
 * Function to compose a prompt using a provided template and state.
 *
 * @param {Object} options - Object containing state and template information.
 * @param {State} options.state - The state object containing values to fill the template.
 * @param {TemplateType} options.template - The template to be used for composing the prompt.
 * @returns {string} The composed prompt output.
 */
export const composePrompt = ({
  state,
  template,
}: {
  state: { [key: string]: string };
  template: TemplateType;
}) => {
  const templateStr = typeof template === 'function' ? template({ state }) : template;
  const templateFunction = handlebars.compile(upgradeDoubleToTriple(templateStr));
  const output = composeRandomUser(templateFunction(state), 10);
  return output;
};

/**
 * Function to compose a prompt using a provided template and state.
 *
 * @param {Object} options - Object containing state and template information.
 * @param {State} options.state - The state object containing values to fill the template.
 * @param {TemplateType} options.template - The template to be used for composing the prompt.
 * @returns {string} The composed prompt output.
 */
export const composePromptFromState = ({
  state,
  template,
}: {
  state: State;
  template: TemplateType;
}) => {
  // function templates is not a good direction
  const templateStr = typeof template === 'function' ? template({ state }) : template;
  const templateFunction = handlebars.compile(upgradeDoubleToTriple(templateStr));

  // get any keys that are in state but are not named text, values or data
  const stateKeys = Object.keys(state);
  const filteredKeys = stateKeys.filter((key) => !['text', 'values', 'data'].includes(key));
  // this flattens out key/values in text/values/data
  const filteredState = filteredKeys.reduce((acc, key) => {
    acc[key] = state[key];
    return acc;
  }, {});

  // and then we flat state.values again
  const output = composeRandomUser(templateFunction({ ...filteredState, ...state.values }), 10);
  return output;
};

/**
 * Adds a header to a body of text.
 *
 * This function takes a header string and a body string and returns a new string with the header prepended to the body.
 * If the body string is empty, the header is returned as is.
 *
 * @param {string} header - The header to add to the body.
 * @param {string} body - The body to which to add the header.
 * @returns {string} The body with the header prepended.
 *
 * @example
 * // Given a header and a body
 * const header = "Header";
 * const body = "Body";
 *
 * // Adding the header to the body will result in:
 * // "Header\nBody"
 * const text = addHeader(header, body);
 */
export const addHeader = (header: string, body: string) => {
  return body.length > 0 ? `${header ? `${header}\n` : header}${body}\n` : '';
};

/**
 * Generates a string with random user names populated in a template.
 *
 * This function generates random user names and populates placeholders
 * in the provided template with these names. Placeholders in the template should follow the format `{{userX}}`
 * where `X` is the position of the user (e.g., `{{name1}}`, `{{name2}}`).
 *
 * @param {string} template - The template string containing placeholders for random user names.
 * @param {number} length - The number of random user names to generate.
 * @returns {string} The template string with placeholders replaced by random user names.
 *
 * @example
 * // Given a template and a length
 * const template = "Hello, {{name1}}! Meet {{name2}} and {{name3}}.";
 * const length = 3;
 *
 * // Composing the random user string will result in:
 * // "Hello, John! Meet Alice and Bob."
 * const result = composeRandomUser(template, length);
 */
export const composeRandomUser = (template: string, length: number) => {
  const exampleNames = Array.from({ length }, () =>
    uniqueNamesGenerator({ dictionaries: [names] })
  );
  let result = template;
  for (let i = 0; i < exampleNames.length; i++) {
    result = result.replaceAll(`{{name${i + 1}}}`, exampleNames[i]);
  }

  return result;
};

export const formatPosts = ({
  messages,
  entities,
  conversationHeader = true,
}: {
  messages: Memory[];
  entities: Entity[];
  conversationHeader?: boolean;
}) => {
  // Group messages by roomId
  const groupedMessages: { [roomId: string]: Memory[] } = {};
  messages.forEach((message) => {
    if (message.roomId) {
      if (!groupedMessages[message.roomId]) {
        groupedMessages[message.roomId] = [];
      }
      groupedMessages[message.roomId].push(message);
    }
  });

  // Sort messages within each roomId by createdAt (oldest to newest)
  Object.values(groupedMessages).forEach((roomMessages) => {
    roomMessages.sort((a, b) => a.createdAt - b.createdAt);
  });

  // Sort rooms by the newest message's createdAt
  const sortedRooms = Object.entries(groupedMessages).sort(
    ([, messagesA], [, messagesB]) =>
      messagesB[messagesB.length - 1].createdAt - messagesA[messagesA.length - 1].createdAt
  );

  const formattedPosts = sortedRooms.map(([roomId, roomMessages]) => {
    const messageStrings = roomMessages
      .filter((message: Memory) => message.entityId)
      .map((message: Memory) => {
        const entity = entities.find((entity: Entity) => entity.id === message.entityId);
        if (!entity) {
          logger.warn('core::prompts:formatPosts - no entity for', message.entityId);
        }
        // TODO: These are okay but not great
        const userName = entity?.names[0] || 'Unknown User';
        const displayName = entity?.names[0] || 'unknown';

        return `Name: ${userName} (@${displayName} EntityID:${message.entityId})
MessageID: ${message.id}${message.content.inReplyTo ? `\nIn reply to: ${message.content.inReplyTo}` : ''}
Source: ${message.content.source}
Date: ${formatTimestamp(message.createdAt)}
Text:
${message.content.text}`;
      });

    const header = conversationHeader ? `Conversation: ${roomId.slice(-5)}\n` : '';
    return `${header}${messageStrings.join('\n\n')}`;
  });

  return formattedPosts.join('\n\n');
};

/**
 * Format messages into a string
 * @param {Object} params - The formatting parameters
 * @param {Memory[]} params.messages - List of messages to format
 * @param {Entity[]} params.entities - List of entities for name resolution
 * @returns {string} Formatted message string with timestamps and user information
 */
export const formatMessages = ({
  messages,
  entities,
}: {
  messages: Memory[];
  entities: Entity[];
}) => {
  const messageStrings = messages
    .reverse()
    .filter((message: Memory) => message.entityId)
    .map((message: Memory) => {
      const messageText = (message.content as Content).text;

      const messageActions = (message.content as Content).actions;
      const messageThought = (message.content as Content).thought;
      const formattedName =
        entities.find((entity: Entity) => entity.id === message.entityId)?.names[0] ||
        'Unknown User';

      const attachments = (message.content as Content).attachments;

      const attachmentString =
        attachments && attachments.length > 0
          ? ` (Attachments: ${attachments
              .map((media) => `[${media.id} - ${media.title} (${media.url})]`)
              .join(', ')})`
          : null;

      const messageTime = new Date(message.createdAt);
      const hours = messageTime.getHours().toString().padStart(2, '0');
      const minutes = messageTime.getMinutes().toString().padStart(2, '0');
      const timeString = `${hours}:${minutes}`;

      const timestamp = formatTimestamp(message.createdAt);

      // const shortId = message.entityId.slice(-5);

      const thoughtString = messageThought
        ? `(${formattedName}'s internal thought: ${messageThought})`
        : null;

      const timestampString = `${timeString} (${timestamp}) [${message.entityId}]`;
      const textString = messageText ? `${timestampString} ${formattedName}: ${messageText}` : null;
      const actionString =
        messageActions && messageActions.length > 0
          ? `${
              textString ? '' : timestampString
            } (${formattedName}'s actions: ${messageActions.join(', ')})`
          : null;

      // for each thought, action, text or attachment, add a new line, with text first, then thought, then action, then attachment
      const messageString = [textString, thoughtString, actionString, attachmentString]
        .filter(Boolean)
        .join('\n');

      return messageString;
    })
    .join('\n');
  return messageStrings;
};

export const formatTimestamp = (messageDate: number) => {
  const now = new Date();
  const diff = now.getTime() - messageDate;

  const absDiff = Math.abs(diff);
  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (absDiff < 60000) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  }
  if (hours < 24) {
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  }
  return `${days} day${days !== 1 ? 's' : ''} ago`;
};

const jsonBlockPattern = /```json\n([\s\S]*?)\n```/;

export const shouldRespondTemplate = `<task>Decide on behalf of {{agentName}} whether they should respond to the message, ignore it or stop the conversation.</task>

<providers>
{{providers}}
</providers>

<instructions>Decide if {{agentName}} should respond to or interact with the conversation.
If the message is directed at or relevant to {{agentName}}, respond with RESPOND action.
If a user asks {{agentName}} to be quiet, respond with STOP action.
If {{agentName}} should ignore the message, respond with IGNORE action.</instructions>

<output>
Respond using XML format like this:
<response>
  <name>{{agentName}}</name>
  <reasoning>Your reasoning here</reasoning>
  <action>RESPOND | IGNORE | STOP</action>
</response>

Your response should ONLY include the <response></response> XML block.
</output>`;

export const messageHandlerTemplate = `<task>Generate dialog and actions for the character {{agentName}}.</task>

<providers>
{{providers}}
</providers>

These are the available valid actions:
<actionNames>
{{actionNames}}
</actionNames>

<instructions>
Write a thought and plan for {{agentName}} and decide what actions to take. Also include the providers that {{agentName}} will use to have the right context for responding and acting, if any.
First, think about what you want to do next and plan your actions. Then, write the next message and include the actions you plan to take.
</instructions>

<keys>
"thought" should be a short description of what the agent is thinking about and planning.
"actions" should be a comma-separated list of the actions {{agentName}} plans to take based on the thought (if none, use IGNORE, if simply responding with text, use REPLY)
"providers" should be an optional comma-separated list of the providers that {{agentName}} will use to have the right context for responding and acting
"evaluators" should be an optional comma-separated list of the evaluators that {{agentName}} will use to evaluate the conversation after responding
"text" should be the text of the next message for {{agentName}} which they will send to the conversation.
"simple" should be true if the message is a simple response and false if it is a more complex response that requires planning, knowledge or more context to handle or reply to.
</keys>

<output>
Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <actions>ACTION1,ACTION2</actions>
    <providers>PROVIDER1,PROVIDER2</providers>
    <text>Your response text here</text>
    <simple>true|false</simple>
</response>

Your response must ONLY include the <response></response> XML block.
</output>`;

export const postCreationTemplate = `# Task: Create a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.

Example task outputs:
1. A post about the importance of AI in our lives
<response>
  <thought>I am thinking about writing a post about the importance of AI in our lives</thought>
  <post>AI is changing the world and it is important to understand how it works</post>
  <imagePrompt>A futuristic cityscape with flying cars and people using AI to do things</imagePrompt>
</response>

2. A post about dogs
<response>
  <thought>I am thinking about writing a post about dogs</thought>
  <post>Dogs are man's best friend and they are loyal and loving</post>
  <imagePrompt>A dog playing with a ball in a park</imagePrompt>
</response>

3. A post about finding a new job
<response>
  <thought>Getting a job is hard, I bet there's a good tweet in that</thought>
  <post>Just keep going!</post>
  <imagePrompt>A person looking at a computer screen with a job search website</imagePrompt>
</response>

{{providers}}

Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
You do not have to continue old patterns, feel free to ignore past posts.
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \\n\\n (double new line) between statements if there are multiple statements in your response.

Your output should be formatted in XML like this:
<response>
  <thought>Your thought here</thought>
  <post>Your post text here</post>
  <imagePrompt>Optional image prompt here</imagePrompt>
</response>

The "post" field should be the post you want to send. Do not including any thinking or internal reflection in the "post" field.
The "imagePrompt" field is optional and should be a prompt for an image that is relevant to the post. It should be a single sentence that captures the essence of the post. ONLY USE THIS FIELD if it makes sense that the post would benefit from an image.
The "thought" field should be a short description of what the agent is thinking about before responding, inlcuding a brief justification for the response. Includate an explanation how the post is relevant to the topic but unique and different than other posts.
Your reponse should ONLY contain the XML block.`;

export const booleanFooter = 'Respond with only a YES or a NO.';
