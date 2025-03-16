import type { OrganizedDocs } from '../AIService/types';

/**
 * Function to generate a comprehensive documentation overview, FAQ, and Troubleshooting section for a given package.
 *
 * @param {any} packageJson - The package.json file with information about the package
 * @param {OrganizedDocs} docs - The organized documentation for the package
 * @returns {string} - The response in JSON structure with overview, FAQ, and Troubleshooting sections
 */
export const PROMPT_TEMPLATES = {
  overview: (packageJson: any, docs: OrganizedDocs) => `
    Using the provided JSDoc as context, create a comprehensive documentation overview, FAQ, and Troubleshooting section for ${packageJson.name}. Return the response in the following JSON structure:
    {
        "overview": {
            "purpose": "A comprehensive paragraph explaining the main purpose",
            "keyFeatures": "List of key features and capabilities"
        },
        "faq": [
            {
                "question": "Common question based on the code structure and functionality",
                "answer": "Detailed answer with examples if applicable"
            }
        ],
        "troubleshooting": {
            "commonIssues": [
                {
                    "issue": "Potential issue based on code structure",
                    "cause": "Likely cause",
                    "solution": "How to solve it"
                }
            ],
            "debuggingTips": [
                "Relevant debugging tips based on the codebase"
            ]
        }
    }

    Base your response on the following package and code information:

    Package Information:
    - Name: ${packageJson.name}
    - Description: ${packageJson.description || 'N/A'}

    Code Components:
    ${
      docs.classes.length > 0
        ? `
    Classes:
    ${docs.classes.map((c) => `- ${c.name}: ${c.jsDoc}`).join('\n')}`
        : ''
    }

    ${
      docs.interfaces.length > 0
        ? `
    Interfaces:
    ${docs.interfaces.map((i) => `- ${i.name}: ${i.jsDoc}`).join('\n')}`
        : ''
    }

    ${
      docs.types.length > 0
        ? `
    Types:
    ${docs.types.map((t) => `- ${t.name}: ${t.jsDoc}`).join('\n')}`
        : ''
    }

    ${
      docs.functions.length > 0
        ? `
    Functions:
    ${docs.functions.map((f) => `- ${f.name}: ${f.jsDoc}`).join('\n')}`
        : ''
    }

    ${
      docs.variables.length > 0
        ? `
    Variables:
    ${docs.variables.map((v) => `- ${v.name}: ${v.jsDoc}`).join('\n')}`
        : ''
    }

    Based on the above components, generate:
    1. A comprehensive overview that explains the plugin's purpose and key features
    2. FAQ entries that cover the following aspects of the code:
       - Action questions: Can the Action do this?
       - Capability questions: For example, Can the Action, Provider, or Evaluator do this in its current state?
       - Integration questions: For example, How to extend this aspect of the code?
       - Common use-case questions: For example, How do I accomplish specific tasks with the code as it stands today?
    3. Troubleshooting guide that anticipates potential issues based on the code structure

    Always include one FAQ pair that states:
        Q: "My action is registered, but the agent is not calling it"
        A: "Ensure that action's name clearly aligns with the task, and ensure you give a detailed description of the conditions that should trigger the action"

    Heres some content from this codebases documentation to help you provide a more accurate Overview, FAQ, and Troubleshooting:

    Providers are core modules that inject dynamic context and real-time information into agent interactions. They serve as a bridge between the agent and various external systems, enabling access to market data, wallet information, sentiment analysis, and temporal context.
        Overview
        A provider's primary purpose is to:
        Supply dynamic contextual information
        Integrate with the agent runtime
        Format information for conversation templates
        Maintain consistent data access

    Actions are core building blocks in Eliza that define how agents respond to and interact with messages. They allow agents to interact with external systems, modify their behavior, and perform tasks beyond simple message responses.
        Overview
        Each Action consists of:
        name: Unique identifier for the action
        similes: Array of alternative names/variations
        description: Detailed explanation of the action's purpose
        validate: Function that checks if action is appropriate
        handler: Implementation of the action's behavior
        examples: Array of example usage patterns

    Evaluators are core components that assess and extract information from conversations. They integrate with the AgentRuntime's evaluation system.
        Overview
        Evaluators enable agents to:
        Build long-term memory
        Extract facts and insights
        Maintain contextual awareness


    Create your FAQ and Troubleshooting based on likely questions and issues that users will have based on the documentation provided above.
    Format the response as a valid JSON object. For the FAQ try and have at least 5-6 questions and answers.

    IMPORTANT: Return only the raw JSON object without any markdown formatting or code blocks.
    `,

  installation: `Create installation instructions with the following structure:

### Prerequisites
[List any prerequisites]

### Steps
1. [First step with code example if needed]
2. [Second step with code example if needed]
[Number each step clearly]

### Verification
[How to verify successful installation]

Format in markdown without adding any additional headers.`,

  configuration: `Create configuration documentation with the following structure:

### Environment Variables
[Table or list of all environment variables with descriptions]

### Example Configuration
\`\`\`env
[Example .env file]
\`\`\`

### Important Notes
[Any important notes about configuration]

Format in markdown without adding any additional headers.`,

  actionDoc: `Generate documentation for this action with the following structure:

### [action name]
[Brief description of the action]

#### Properties
- Name: [action name]
- Similes: [list of similes]

#### Handler
[Description of what the handler does]

#### Examples
[Use Examples object in Action code to give a Natural language example replace {{name2}} with "Agent" and {{name1}} with "Anon"]

Format in markdown without adding any additional headers.`,

  providerDoc: `Generate documentation for this provider with the following structure:

### [Provider Name]
[Brief description of the provider]

#### Methods
[Textual description of the get() method and its functionality.]

Format in markdown without adding any additional headers.`,

  fileUsageDoc: `Determine multiple use cases for the provided code, and give examples of how to use the code:

### Common Use Cases
1. [First use case with code example]
2. [Second use case with code example]

### Best Practices
- [Best practice 1]
- [Best practice 2]

Format in markdown without adding any additional headers.`,

  fileApiDoc: `Generate API reference documentation with the following structure:

### Classes
\`\`\`typescript
[List each class with its methods and properties]
\`\`\`
### Interfaces
\`\`\`typescript
[List each interface with its properties]
\`\`\`

### Types
\`\`\`typescript
[List each type with its definition]
\`\`\`

### Functions
\`\`\`typescript
[List each function with its parameters and return type]
\`\`\`


Create a comprehensive API reference including:
1. Class descriptions and methods
2. Method signatures and parameters
3. Return types and values
4. Interface definitions
5. Type definitions
6. Examples for complex APIs

Format the response in markdown with proper headings and code blocks.`,

  todos: `Generate TODO documentation with the following structure, DO NOT return the context/code rather a description of the code and how the todo is related to the code, if no todos are provided return "No todos found in the code":

### Items
1. [First TODO item]
   - Context: [describe the code associated with the todo]
   - Type: [bug/feature/enhancement]
2. [Second TODO item]
   - Context: [describe the code associated with the todo]
   - Type: [bug/feature/enhancement]

Format in markdown without adding any additional headers.`,

  troubleshooting: `Generate troubleshooting guide with the following structure:

### Common Issues
1. [First issue]
   - Cause: [cause of the issue]
   - Solution: [how to solve it]

### Debugging Tips
- [First debugging tip]
- [Second debugging tip]
- Ask your questions at https://eliza.gg/ 🚀 or in our discord

Format in markdown without adding any additional headers.`,
};
