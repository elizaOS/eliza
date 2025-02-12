---
Title: AI Agent Dev School Part 2
description: "Deep Dive into Actions, Providers, and Evaluators"
---

# Part 2: Deep Dive into Actions, Providers, and Evaluators

In this second session of the AI Agent Dev School series, we take a deep dive into the key abstractions in the Eliza framework that enable developers to create powerful AI agents:

- **Actions**: The tasks and responses that agents can perform.
- **Providers**: Modules that provide information and state to the agent's context.
- **Evaluators**: Modules that analyze situations and agent actions, often triggering further actions or modifications.

We explore each of these in detail, walking through code examples and common use cases. We also cover how to package up actions, providers and evaluators into reusable plugins.

# Key Sections

- [**00:03:33** - Shift in focus from characters (Dev School Part 1) to agent capabilities](https://www.youtube.com/watch?v=XenGeAcPAQo&t=213)
- [**00:07:09** - Deep dive into providers, actions, and evaluators, the core building blocks of Eliza](https://www.youtube.com/watch?v=XenGeAcPAQo&t=429)
- [**00:07:28** - Discussion about actions vs. tools, favoring decoupled intent and action execution](https://www.youtube.com/watch?v=XenGeAcPAQo&t=448)
- [**00:18:02** - Explanation of providers and their function as information sources for agents](https://www.youtube.com/watch?v=XenGeAcPAQo&t=1082)
- [**00:20:15** - Introduction to evaluators and their role in agent reflection and state analysis](https://www.youtube.com/watch?v=XenGeAcPAQo&t=1215)
- [**00:29:22** - Brief overview of clients as connectors to external platforms](https://www.youtube.com/watch?v=XenGeAcPAQo&t=1762)
- [**00:31:02** - Description of adapters and their function in database interactions](https://www.youtube.com/watch?v=XenGeAcPAQo&t=1862)
- [**00:34:02** - Discussion about plugins as bundles of core components, examples, and recommendations](https://www.youtube.com/watch?v=XenGeAcPAQo&t=2042)
- [**00:40:31** - Live Coding Demo begins: Creating a new plugin from scratch (DevSchoolExamplePlugin)](https://www.youtube.com/watch?v=XenGeAcPAQo&t=2431)
- [**00:47:54** - Implementing the simple HelloWorldAction](https://www.youtube.com/watch?v=XenGeAcPAQo&t=2791)
- [**01:00:26** - Implementing the CurrentNewsAction (fetching and formatting news data)](https://www.youtube.com/watch?v=XenGeAcPAQo&t=3626)
- [**01:22:09** - Demonstrating the Eliza Client for interacting with agents locally](https://www.youtube.com/watch?v=XenGeAcPAQo&t=4929)
- [**01:23:54** - Q&A: Plugin usage in character files, installation, Eliza vs. Eliza Starter](https://www.youtube.com/watch?v=XenGeAcPAQo&t=5034)
- [**01:36:17** - Saving agent responses as memories in the database](https://www.youtube.com/watch?v=XenGeAcPAQo&t=5777)
- [**01:43:06** - Using prompts for data extraction within actions](https://www.youtube.com/watch?v=XenGeAcPAQo&t=6186)
- [**01:51:54** - Importance of deleting the database during development to avoid context issues](https://www.youtube.com/watch?v=XenGeAcPAQo&t=6714)
- [**01:57:04** - Viewing agent context via console logs to understand model inputs](https://www.youtube.com/watch?v=XenGeAcPAQo&t=7024)
- [**02:07:07** - Explanation of memory management with knowledge, facts, and lore](https://www.youtube.com/watch?v=XenGeAcPAQo&t=7627)
- [**02:16:53** - Q&A: Prompt engineering opportunities, knowledge chunking and retrieval](https://www.youtube.com/watch?v=XenGeAcPAQo&t=8213)
- [**02:22:57** - Call for contributions: Encouraging viewers to create their own actions and plugins](https://www.youtube.com/watch?v=XenGeAcPAQo&t=8577)
- [**02:26:31** - Closing remarks and future DevSchool session announcements](https://www.youtube.com/watch?v=XenGeAcPAQo&t=8791)

# Working with Actions

Actions represent the core capabilities of an AI agent - the things it can actually do. In Eliza, an action is defined by:

- **Name**: The unique name used to reference the action
- **Description**: Used to inform the agent when this action should be invoked
- **Handler**: The code that actually executes the action logic
- **Validator**: Determines if the action is valid to be called given the current context

Some key points about actions in Eliza:

- The agent decides which action to call based on the name and description. It does not have insight into the actual action code.
- The handler receives the agent runtime, the triggering message, the current state, and a callback function to send messages back to the user.
- The validate function allows for complex logic to determine action availability based on context and state.

# Providers: Injecting State and Context

Providers allow developers to dynamically inject relevant information into the agent's context. This could be real-time data, user information, results of previous conversations, or any other state the agent may need.

Key aspects of providers:

- Defined by a single `get` function that returns relevant state
- Called before each agent execution to hydrate the context
- Can conditionally provide state based on the current context

Common provider examples include current time, user preferences, conversation history, and external API data.

# Evaluators: Reflection and Analysis

Evaluators run after each agent action, allowing the agent to reflect on what happened and potentially trigger additional actions. They are a key component in creating agents that can learn and adapt.

Some common use cases for evaluators:

- Extracting and storing facts from a conversation for future reference
- Analyzing user sentiment to measure trust and relationship
- Identifying key intents and entities to inform future actions
- Implementing feedback loops for agent improvement

Evaluators work in close conjunction with providers - often an evaluator will extract some insight that a provider will then inject into future context.

# Packaging Plugins

The plugin system in Eliza allows developers to package up related actions, providers and evaluators into reusable modules. A plugin is defined by:

- `package.json`: Metadata about the plugin
- `tsconfig.json`: TypeScript configuration
- `index.ts`: Registers the plugin's actions, providers and evaluators
- `src` directory: Contains the actual action, provider and evaluator code

Plugins can be published to npm and then easily imported into any Eliza agent. This enables a powerful ecosystem of reusable agent capabilities.

# Examples

The session walks through several code examples to illustrate these concepts:

1. Defining a simple "Hello World" action
2. Creating a "Current News" action that retrieves news headlines
3. Implementing a provider that injects a random emotion into the context
4. Registering actions and providers in a plugin

# Key Takeaways

- Actions, providers and evaluators are the core building blocks of agent behavior in Eliza
- Actions define what agents can do, providers manage context and state, and evaluators allow for reflection and adaptation
- The plugin system enables reusable packaging of agent capabilities
- Effective prompt engineering around the composition of the agent context is a key area for optimization

With a solid understanding of these abstractions, developers have immense power and flexibility to create agent behaviors in Eliza. The next session will dive into an end-to-end example.
