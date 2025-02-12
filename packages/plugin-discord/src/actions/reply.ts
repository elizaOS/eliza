import type {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State
} from "@elizaos/core";
  
  const replyAction = {
    name: "REPLY",
    similes: ["REPLY_TO_MESSAGE", "SEND_REPLY"],
    description: "Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action.",
    validate: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State
    ) => {
      if (message.content.source !== "discord") {
        return false;
      }
      return true;
    },
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state: State,
      options: any,
      callback: HandlerCallback,
      responses: Memory[]
    ) => {
        for (const response of responses) {
            await callback(response.content);
        }
    },
    examples: [
      // Basic greeting and response
      [
        {
          user: "{{user1}}",
          content: {
            text: "Hi there!",
            source: "telegram",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "Hello! How can I help you today?",
            action: "REPLY",
          },
        },
      ],
  
      // Question and informative response
      [
        {
          user: "{{user1}}",
          content: {
            text: "What time does the library close?",
            source: "telegram",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "I apologize, but I don't have access to specific library hours. Could you specify which library you're asking about? I'd be happy to help you find that information.",
            action: "REPLY",
          },
        },
      ],
  
      // Request for clarification
      [
        {
          user: "{{user1}}",
          content: {
            text: "Can you help me with the thing?",
            source: "telegram",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "I'd be happy to help, but could you please provide more details about what specific thing you need assistance with?",
            action: "REPLY",
          },
        },
      ],
  
      // Multi-part message
      [
        {
          user: "{{user1}}",
          content: {
            text: "Tell me about pasta recipes",
            source: "telegram",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "Here are some popular pasta recipes you might enjoy:\n\nClassic Spaghetti Carbonara:\n- Eggs\n- Pecorino Romano\n- Guanciale or pancetta\n- Black pepper\n\nSimple Marinara:\n- Tomatoes\n- Garlic\n- Basil\n- Olive oil\n\nWould you like more details about any of these recipes?",
            action: "REPLY",
          },
        },
      ],
  
      // Handling a request for help
      [
        {
          user: "{{user1}}",
          content: {
            text: "I need help with my account settings",
            source: "telegram",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "I'll be glad to help you with your account settings. Which specific aspect would you like to address?\n\n- Password changes\n- Profile information\n- Notification preferences\n- Privacy settings",
            action: "REPLY",
          },
        },
      ],
  
      // Acknowledgment and follow-up
      [
        {
          user: "{{user1}}",
          content: {
            text: "Thanks for your help!",
            source: "telegram",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "You're welcome! Is there anything else you'd like assistance with?",
            action: "REPLY",
          },
        },
      ],
  
      // Error acknowledgment
      [
        {
          user: "{{user1}}",
          content: {
            text: "Something went wrong with my last request",
            source: "telegram",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "I apologize for the inconvenience. Could you please describe what happened with your last request? This will help me better assist you in resolving the issue.",
            action: "REPLY",
          },
        },
      ],
  
      // Handling specific instructions
      [
        {
          user: "{{user1}}",
          content: {
            text: "Please remind me about my appointment tomorrow",
            source: "telegram",
          },
        },
        {
          user: "{{user2}}",
          content: {
            text: "While I can't set reminders directly, I can suggest some ways to help you remember your appointment:\n\n1. Set an alarm on your phone\n2. Add it to your calendar\n3. Write it down in your planner\n\nWould you like me to explain how to set up any of these reminder methods?",
            action: "REPLY",
          },
        },
      ],
    ],
  } as Action;
  
  export default replyAction;