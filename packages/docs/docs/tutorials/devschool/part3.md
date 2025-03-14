---
Title: AI Agent Dev School Part 3
description: "Building a User Data Extraction Agent"
---

# Part 3: Building a User Data Extraction Agent

In this third session of the AI Agent Dev School series, we dive into a practical application of providers and evaluators in the Eliza framework - building an agent that can extract key user data (name, location, job) through natural conversation.

We explore:

- The provider-evaluator loop for gathering information and triggering actions
- Deep dive into evaluators and their role in agent self-reflection
- Code walkthrough of real-world evaluators and providers
- Building a user data extraction flow from scratch
- Dynamic providers based on completion state
- Q&A on advanced topics and use cases

<div className="responsive-iframe">
  <iframe
    src="https://www.youtube.com/embed/Y1DiqSVy4aU"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowFullScreen
  />
</div>


# Key Sections

- [**00:00:00** - Intro & Housekeeping](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=0)
- [**00:08:05** - Building a Form-Filling Agent](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=485)
- [**00:16:15** - Deep Dive into Evaluators](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=975)
- [**00:27:45** - Code walkthrough of the "Fact Evaluator"](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=1675)
- [**00:36:07** - Building a User Data Evaluator](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=2167)
- [**00:51:50** - Exploring Eliza's Cache Manager](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=3110)
- [**01:06:01** - Using Claude AI for Code Generation](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=3961)
- [**01:21:18** - Testing the User Data Flow](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=4878)
- [**01:30:27** - Adding a Dynamic Provider Based on Completion](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=5427)
- [**01:37:16** - Q&A with the Audience](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=5836)
- [**01:47:31** - Outro and Next Steps](https://www.youtube.com/watch?v=Y1DiqSVy4aU&t=6451)

# The Provider-Evaluator Loop

A key concept introduced in this session is the provider-evaluator loop for gathering information and triggering actions:

1. The provider checks the cache/database for information we already have
2. If information is missing, the provider indicates to the agent what it needs to extract
3. The evaluator extracts new information from user messages and stores it
4. Once all required information is gathered, the evaluator triggers a completion action

This loop allows agents to dynamically gather required data through natural conversation, enabling powerful form-filling and user profiling applications.

# Deep Dive into Evaluators

Evaluators in Eliza run after each agent action, allowing the agent to reflect on what happened and potentially trigger additional actions. Some key aspects of evaluators:

- Defined by `validate` and `handler` functions
- `validate` determines if the evaluator should run based on the current context
- `handler` contains the core evaluator logic - state updates, data extraction, triggering actions, etc.
- Evaluators work in close conjunction with providers to extract insights and inject them into future context

Common use cases include extracting conversation facts, analyzing sentiment, identifying intents, and implementing feedback loops.

# Building the User Data Extraction Flow

The hands-on portion of the session focuses on building a user data extraction flow from scratch. Key steps include:

1. Creating a basic `UserDataEvaluator` and `UserDataProvider`
2. Registering them directly in the agent (without a plugin)
3. Leveraging Eliza's `CacheManager` for efficient key-value storage
4. Iteratively developing the extraction logic with the help of Claude AI
5. Testing the flow by interacting with the agent and inspecting logs/context
6. Adding a dynamic provider that triggers only after data collection is complete

Through this process, we see how providers and evaluators work together to enable complex, stateful agent behaviors.

# Using AI Assistants in Development

A notable aspect of the session is the use of Claude AI to aid in code development. By providing clear instructions and iterating based on the generated code, complex logic can be developed rapidly.

This showcases the potential for AI pair programming and how future developers might interact with their AI counterparts to build sophisticated applications.

# Key Takeaways

- Providers and evaluators are the key to stateful, dynamic agent behaviors
- The provider-evaluator loop is a powerful pattern for gathering information and triggering actions
- Evaluators enable agent self-reflection and adaptation based on conversation context
- AI assistants can significantly accelerate development by generating and refining code
- The potential for provider-evaluator based applications is immense - form-filling, user profiling, dynamic content unlocking, and more

With these tools in hand, developers have a solid foundation for building highly interactive, personalized agentic applications. The next frontier is to explore advanced use cases and further push the boundaries of what's possible with Eliza.
