import { messageCompletionFooter, shouldRespondFooter } from "@elizaos/core";

export const homeShouldRespondTemplate = `
# Task: Decide if the assistant should respond to home automation requests.

# Current home state:
{{homeState}}

# Recent message:
{{message}}

# Instructions: Determine if the assistant should respond to the message and control home devices.
Response options are [RESPOND], [IGNORE] and [STOP].

The assistant should:
- Respond with [RESPOND] to direct home automation requests (e.g., "turn on the lights")
- Respond with [RESPOND] to questions about device states (e.g., "are the lights on?")
- Respond with [IGNORE] to unrelated messages
- Respond with [STOP] if asked to stop controlling devices

Choose the option that best describes how the assistant should respond to the message:`;

export const homeMessageHandlerTemplate = `
# Task: Generate a response for a home automation request.

# Current home state:
{{homeState}}

# User command:
{{command}}

# Command result:
{{result}}

# Instructions: Write a natural response that confirms the action taken and its result.
The response should be friendly and conversational while clearly indicating what was done.

Response:`;