import { OrganizedDocs } from "../types";

export const PROMPT_TEMPLATES = {
    overview: (packageJson: any, docs: OrganizedDocs) => `
    Create an overview for ${packageJson.name} with the following structure and details:

### Purpose
[Write a comprehensive paragraph explaining the main purpose based on the package details below]

Package Information:
- Name: ${packageJson.name}
- Description: ${packageJson.description || 'N/A'}
- Version: ${packageJson.version || 'N/A'}
- Keywords: ${(packageJson.keywords || []).join(', ')}

### Key Features

Code Components:
${docs.classes.length > 0 ? `
Classes:
${docs.classes.map(c => `- ${c.name}: ${c.jsDoc}`).join('\n')}` : ''}

${docs.interfaces.length > 0 ? `
Interfaces:
${docs.interfaces.map(i => `- ${i.name}: ${i.jsDoc}`).join('\n')}` : ''}

${docs.types.length > 0 ? `
Types:
${docs.types.map(t => `- ${t.name}: ${t.jsDoc}`).join('\n')}` : ''}

${docs.functions.length > 0 ? `
Functions:
${docs.functions.map(f => `- ${f.name}: ${f.jsDoc}`).join('\n')}` : ''}

Based on the above components, list the key features and capabilities of this plugin:
- Feature 1: Brief description
- Feature 2: Brief description
[List key features with brief descriptions]

Format in markdown without adding any additional headers.`,

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
[Use Examples object in Action code to give a Natural language example replace {{user2}} with "Agent" and {{user1}} with "User"]

Format in markdown without adding any additional headers.`,

    providerDoc: `Generate documentation for this provider with the following structure:

### [Provider Name]
[Brief description of the provider]

#### Methods
[Focus on the get() method and its functionality.]

#### Usage
\`\`\`typescript
[Example usage code]
\`\`\`

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

### FAQ
Q: [Common question]
A: [Answer with example if applicable]

Format in markdown without adding any additional headers.`
};