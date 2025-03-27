# @elizaos/core Documentation

## Overview
### Purpose
The @elizaos/core package is designed to provide flexible and dynamic interaction capabilities for an AI agent, allowing it to perform various tasks beyond simple message responses. This includes managing entities, memories, and interacting with external systems in dynamic environments. By leveraging foundational components such as providers, actions, and evaluators, the package empowers the agent to process complex scenarios, maintain contextual awareness, and execute tasks in a sophisticated manner.

### Key Features
Dynamic providers for maintaining real-time context,Actions for agent interaction and response management,Evaluators for extracting insights from conversations,Support for managing entities and memories,Scalable architecture for testing environments

## Installation
## Installation and Integration Instructions for @elizaos/core Plugin

### How to add the plugin to your ElizaOS project:

1. Add the following to your agent/package.json dependencies:
   ```json
   {
     "dependencies": {
       "@elizaos/core": "workspace:*"
     }
   }
   ```

2. Cd into the agent/ directory
3. Run `bun install` to install the new dependency
4. Run `bun run build` to build the project with the new plugin

### Importing and Using the Plugin:

- Import syntax: `import { corePlugin } from "@elizaos/core";`
- Add it to the AgentRuntime plugins array:

```typescript
import { corePlugin } from "@elizaos/core";

return new AgentRuntime({
    // other configuration...
    plugins: [
        corePlugin,
        // other plugins...
    ],
});
```

### Integration Example:

```typescript
import { corePlugin } from "@elizaos/core";

return new AgentRuntime({
    // other configuration...
    plugins: [
        corePlugin,
        // other plugins...
    ],
});
```

### Verification Steps:

Ensure you see ["✓ Registering action: <plugin actions>"] in the console.

These steps should help you successfully install and integrate the @elizaos/core plugin into your ElizaOS project.

## Configuration
# Configuration Documentation

### Required Environment Variables and Their Purpose:
1. `LOG_LEVEL`: controls the logging level, such as 'debug', 'info', 'error', etc.
2. `LOG_DIAGNOSTIC`: enables/disables diagnostic logging.
3. `LOG_JSON_FORMAT`: configures whether the log messages are in JSON format.
4. `DEFAULT_LOG_LEVEL`: specifies the default logging level if debug mode is not enabled.
5. `SECRET_SALT`: stores a secret salt for encryption purposes.

### Example .env File:
```plaintext
LOG_LEVEL=debug
LOG_DIAGNOSTIC=true
LOG_JSON_FORMAT=false
DEFAULT_LOG_LEVEL=info
SECRET_SALT=mysecretsalt123
```

**Note:** The configuration should be done in the .env file. Ensure the .env file is added to the .gitignore to avoid committing sensitive data to the repository.

## Features

### Actions
No actions documentation available.

### Providers
No providers documentation available.

### Evaluators
No evaluators documentation available.

## Usage Examples
### database.ts

### Common Use Cases
1. Creating a new database adapter instance:
```typescript
import { DatabaseAdapter } from './database';

const dbAdapter = new DatabaseAdapter();
```

2. Implementing a custom database adapter class:
```typescript
import { DatabaseAdapter } from './database';

class CustomDatabaseAdapter extends DatabaseAdapter {
   // Implement custom methods here
}
```

### Best Practices
- Utilize the abstract class to define a common interface for different database adapter implementations.
- Encapsulate database logic within the adapter classes to promote code reuse and maintainability.

### logger.ts

- Use Case 1: Logging System
```typescript
import { LoggerWithClear, LogEntry, InMemoryDestination } from './logger';

const logger = new InMemoryDestination();

const logEntry: LogEntry = {
  time: Date.now(),
  key: 'login',
  value: 'User successfully logged in'
};

logger.write(logEntry);

const recentLogs = logger.recentLogs();
console.log(recentLogs);
```

- Use Case 2: Parsing Boolean Values
```typescript
import { parseBooleanFromText } from './logger';

const textInput: string = 'true';
const booleanValue = parseBooleanFromText(textInput);
console.log(booleanValue);
```

- Best Practice 1: Encapsulate Logging Functionality
- Best Practice 2: Clear Logs Regularly to Avoid Overflow

### runtime.ts

### Common Use Cases
1. Create an instance of AgentRuntime to manage agents and their interactions within a simulated environment.
```typescript
import { AgentRuntime } from 'runtime';

const agentRuntime = new AgentRuntime();
```

2. Acquire and release semaphores within the agent runtime to control access to shared resources.
```typescript
agentRuntime.acquire('resource1');
// Use the shared resource here
agentRuntime.release('resource1');
```

### Best Practices
- Always initialize the AgentRuntime instance before using any other methods.
- Make use of the registerPlugin method to extend the functionality of AgentRuntime with custom plugins.

### types.ts

### Common Use Cases
1. Using the provided code to define various types and interfaces for different components in a project.
```typescript
// Importing the UUID type definition
import { UUID } from 'types';

// Using the UUID type in defining a class
class Service {
  id: UUID;
  // other class properties and methods
}
```

2. Implementing the defined types and interfaces in different parts of the codebase for consistency and clear data structure.
```typescript
// Implementing the Content interface
interface Content {
  id: UUID;
  content: string;
}

// Using the Content interface in a function
function processContent(data: Content) {
  // Process the content data
}
```

### Best Practices
- Ensure consistent usage of the defined types and interfaces throughout the project for better code readability and maintainability.
- Document and describe each type and interface to provide context and understanding for other developers working on the project.

### /home/runner/work/eliza/eliza/packages/core/__tests__/database.test.ts

### Common Use Cases
1. Initializing the database adapter:
```typescript
const mockAdapter = new MockDatabaseAdapter();
await mockAdapter.init();
```

2. Getting entities for a specific room:
```typescript
const roomId = '123456';
const entities = await mockAdapter.getEntitiesForRoom(roomId, true);
console.log(entities);
```

### Best Practices
- Use appropriate parameter types in method signatures.
- Add descriptive comments to explain the purpose of each method.

### services/scenario.ts

### Common Use Cases
1. Starting a scenario testing environment: 
```typescript
import { startScenario } from 'services/scenario';

startScenario();
```

2. Creating a new room in the scenario testing environment:
```typescript
import { ScenarioService } from 'services/scenario';

const scenarioService = new ScenarioService();
const roomId = scenarioService.createRoom();
```

### Best Practices
- Ensure to set up event listeners before starting the scenario to handle events appropriately.
- Clean up resources and participants using the `cleanup` method after completing the scenario testing.

### services/task.ts

### Common Use Cases
1. Starting the TaskService to schedule and execute tasks:
```typescript
const runtime: IAgentRuntime = // initialize runtime
TaskService.start(runtime);
```

2. Creating test tasks with the TaskService:
```typescript
TaskService.createTestTasks();
```

### Best Practices
- Ensure to pass the required runtime parameter when starting the TaskService.
- Use the createTestTasks method for testing and validating the TaskService functionality.

### actions/roles.ts

### Common Use Cases
1. Checking if a user with a certain role can modify another user's role:
```typescript
const canModifyRole = RoleAssignment(currentRole, targetRole, newRole);
if (canModifyRole) {
    // Modify the role for the target user
} else {
    // Display an error message or prevent the role modification
}
```

2. Restricting access to certain actions based on user roles:
```typescript
if (currentRole === 'admin') {
    // Allow access to an admin-only action
} else {
    // Display an error message or prevent access to the action
}
```

### Best Practices
- Validate input parameters before calling the `RoleAssignment` function to ensure data integrity.
- Use role-based access control to manage permissions for different user roles.

### services/websocket.ts

### Common Use Cases
1. Establishing a websocket connection between a client and a server:
```
import { IWebSocketService } from './services/websocket';

const websocketService: IWebSocketService = new WebSocketService();
websocketService.connect('ws://example.com');
```

2. Sending a text message over a websocket connection:
```
import { IWebSocketService, TextMessagePayload } from './services/websocket';

const websocketService: IWebSocketService = new WebSocketService();
websocketService.connect('ws://example.com');

const message: TextMessagePayload = {
  content: 'Hello, world!'
};
websocketService.sendMessage(message);
```

### Best Practices
- Always ensure that the websocket connection is established before attempting to send or receive messages.
- Implement proper error handling to deal with network issues or unexpected behavior when using the websocket service.

### test_resources/types.ts

### Common Use Cases
1. **Creating a User object:**
```typescript
import { User } from './test_resources/types';

const newUser: User = {
  id: '123',
  email: 'user@example.com',
  phone: '555-555-5555',
  role: 'admin'
};
```

2. **Updating a User object:**
```typescript
import { User } from './test_resources/types';

const updatedUser: User = {
  id: '123',
  email: 'newuser@example.com',
  phone: '444-444-4444',
  role: 'user'
};
```

### Best Practices
- **Use interfaces to define data structures:** By using interfaces like `User` to define the structure of data objects, it helps in type-checking and ensuring consistency in the codebase.
- **Provide default values for optional properties:** When defining interfaces with optional properties like `email`, `phone`, and `role`, consider providing default values to maintain clarity in data structures.

### actions/settings.ts

### Common Use Cases
1. **Update world settings:** Update various settings related to the world in a game or application.
```typescript
const settingUpdate: SettingUpdate = { key: 'worldSize', value: 'large' };
updateWorldSettings(settingUpdate);
```

2. **Get world settings:** Retrieve the current settings of the world to display or use in the application.
```typescript
const worldSettings = getWorldSettings();
console.log(worldSettings);
```

### Best Practices
- **Consistent data structure:** Ensure that all setting update objects adhere to the `SettingUpdate` interface to maintain consistency and avoid errors.
- **Error handling:** Utilize the `generateFailureResponse` and `generateErrorResponse` functions to handle errors and provide appropriate responses.

### providers/choice.ts

### Common Use Cases
1. **Render a list of options:** You can use the `ChoiceProvider` class to render a list of options in a dropdown menu or radio button group.

```typescript
import { ChoiceProvider } from './providers/choice';

const options = [
  { name: 'Option 1' },
  { name: 'Option 2', description: 'This is option 2' }
];

const choiceProvider = new ChoiceProvider(options);
```

2. **Handle user selection:** You can use the `ChoiceProvider` class to handle user selection of options and perform actions based on the selected option.

```typescript
import { ChoiceProvider } from './providers/choice';

const options = [
  { name: 'Option 1' },
  { name: 'Option 2', description: 'This is option 2' }
];

const choiceProvider = new ChoiceProvider(options);

choiceProvider.onSelect((selectedOption) => {
  console.log(`Selected option: ${selectedOption.name}`);
});
```

### Best Practices
- **Type checking:** Ensure that the options provided to the `ChoiceProvider` class adhere to the `OptionObject` interface for consistency and type safety.
- **Error handling:** Implement error handling mechanisms in the `ChoiceProvider` class to gracefully handle any unexpected behaviors or issues.

### roles.ts

### Common Use Cases
1. Use Case 1: Retrieving the user's server role
```typescript
import { getUserServerRole } from 'roles';

const userRole = getUserServerRole(userId);
console.log(userRole);
```

2. Use Case 2: Finding the world for a specific server owner
```typescript
import { findWorldForOwner } from 'roles';

const world = findWorldForOwner(ownerId);
console.log(world);
```

### Best Practices
- Ensure to handle error cases when using the functions, such as if the user ID or owner ID does not exist in the system.
- Document the returned data structure of the functions for better understanding and usage by other developers.

### prompts.ts

### Common Use Cases
1. Using the `parseBooleanFromText` function to parse a boolean value from a text string.
```typescript
// Given a text string
const text = "true";

// Parsing the boolean value from the text string
const booleanValue = parseBooleanFromText(text);
console.log(booleanValue); // Output: true 
```

2. Using the `extractAttributes` function to extract attributes from a template string.
```typescript
// Given a template string with placeholders
const template = "My name is {{name}} and I am {{age}} years old";

// Extracting attributes from the template string
const attributes = extractAttributes(template);
console.log(attributes); // Output: ["name", "age"]
```

### Best Practices
- When using any of the parsing functions, ensure that the input text or template is formatted correctly to avoid errors during parsing.
- It is recommended to provide meaningful names for placeholders within the template string to make the code more readable and maintainable.

### bootstrap.ts

### Common Use Cases
1. Fetching media data from attachments:
```typescript
import { fetchMediaData } from 'bootstrap';

const attachments = [...array of Media objects];
fetchMediaData(attachments)
    .then((mediaDataArray) => {
        console.log(mediaDataArray);
    })
    .catch((error) => {
        console.error(error);
    });
```

2. Processing fetched media data:
```typescript
import { fetchMediaData } from 'bootstrap';

const attachments = [...array of Media objects];
fetchMediaData(attachments)
    .then((mediaDataArray) => {
        mediaDataArray.forEach((mediaData) => {
            // Process each media data (e.g. displaying images, playing videos)
        });
    })
    .catch((error) => {
        console.error(error);
    });
```

### Best Practices
- When using the `fetchMediaData` function, ensure that the `attachments` parameter is an array of valid Media objects to avoid errors.
- Handle promise rejections by implementing error handling using `.catch()` to provide feedback to users in case of retrieval failures.

### actions.ts

### Common Use Cases

1. Generating example conversations for testing purposes:
```typescript
import { formatActionNames } from './actions';

const actions = [
  { name: 'Greet', type: 'text' },
  { name: 'Farewell', type: 'text' },
];

const examples = formatActionNames(actions, 3);
console.log(examples);
```

2. Creating mock data for displaying sample conversations in a user interface:
```typescript
import { formatActions } from './actions';

const actionsData = [
  { name: 'Search', type: 'search' },
  { name: 'Add to Cart', type: 'button' },
];

const mockConversations = formatActions(actionsData, 5);
console.log(mockConversations);
```

### Best Practices
- Always provide an array of action objects with appropriate properties for generating realistic examples.
- Consider testing the behavior of the functions with different input data to ensure reliable output.

### entities.ts

### Common Use Cases
1. Using the `getRecentInteractions` function to retrieve the most recent interactions of an entity in a conversation context:
   
   ```typescript
   import { getRecentInteractions } from 'entities.ts';
   
   const entityName = 'Alice';
   const recentInteractions = getRecentInteractions(entityName);
   console.log(recentInteractions);
   ```

2. Using the `getEntityDetails` function to retrieve detailed information about a specific entity in a conversation context:

   ```typescript
   import { getEntityDetails } from 'entities.ts';
   
   const entityName = 'Bob';
   const entityDetails = getEntityDetails(entityName);
   console.log(entityDetails);
   ```

### Best Practices
- When using these functions, make sure to provide the correct entity name as an argument to ensure accurate results.
- It is recommended to handle error cases when calling these functions to gracefully handle any exceptions that may occur.

### evaluators/reflection.ts

### Common Use Cases
1. **Resolve Entity:**
   ```typescript
   import { resolveEntity } from 'evaluators/reflection';

   const entity = resolveEntity({
       facts: [
           { claim: 'Albert Einstein is a physicist', type: 'profession', in_bio: true, already_known: true },
           { claim: 'Albert Einstein was born in 1879', type: 'birth', in_bio: true, already_known: true }
       ],
       relationships: [
           { relation: 'Albert Einstein', type: 'colleague', related_to: 'Marie Curie' }
       ]
   });

   console.log(entity);
   ```

2. **Handler:**
   ```typescript
   import { handler } from 'evaluators/reflection';

   const handlerOutput = handler({
       facts: [
           { claim: 'Marie Curie was a scientist', type: 'profession', in_bio: true, already_known: true },
           { claim: 'Marie Curie discovered radium', type: 'discovery', in_bio: true, already_known: true }
       ],
       relationships: [
           { relation: 'Marie Curie', type: 'colleague', related_to: 'Albert Einstein' }
       ]
   });

   console.log(handlerOutput);
   ```

### Best Practices
- **Ensure to provide accurate and relevant facts and relationships while using the provided functions.**
- **Make use of the different functions provided in the file to effectively reflect on a topic with necessary details.**

### providers/evaluators.ts

- **Common Use Cases**
1. Formatting evaluators' names into a comma-separated list, each enclosed in single quotes.
   ```typescript
   import { formatEvaluatorNames } from 'providers/evaluators';

   const evaluators = [{name: 'Alice'}, {name: 'Bob'}, {name: 'Charlie'}];
   const formattedNames = formatEvaluatorNames(evaluators);
   console.log(formattedNames); // Output: 'Alice', 'Bob', 'Charlie'
   ```

2. Formatting evaluator examples' names into a comma-separated list, each enclosed in single quotes.
   ```typescript
   import { formatEvaluatorExamples } from 'providers/evaluators';

   const examples = [{name: 'Example 1'}, {name: 'Example 2'}, {name: 'Example 3'}];
   const formattedExamples = formatEvaluatorExamples(examples);
   console.log(formattedExamples); // Output: 'Example 1', 'Example 2', 'Example 3'
   ```

- **Best Practices**
  - Ensure to pass an array of evaluator objects when using the formatting functions to avoid errors.
  - Consider using these functions when displaying evaluator information in a user-friendly format.

### providers/settings.ts

### Common Use Cases

1. Using the generateStatusMessage function to display a setting value with privacy flags:
```typescript
import { generateStatusMessage } from './providers/settings';

const settingValue = '******';
const statusMessage = generateStatusMessage(settingValue);
console.log(statusMessage); // Output: "Private Data"
```

2. Manipulating and filtering settings data based on privacy flags:
```typescript
import { settingsData } from './providers/settings';

const filteredSettings = settingsData.filter(setting => !setting.private);
console.log(filteredSettings); // Output: Array of settings without private data
```

### Best Practices

- When using the generateStatusMessage function, make sure to handle any edge cases where the input value may not conform to expected formats.
- Maintain clear documentation for settings data structure and privacy flag conventions to ensure consistent usage throughout the application.

### settings.ts

### Common Use Cases
1. Setting up encryption and decryption for sensitive data:
```typescript
const configSetting = {
  name: "password",
  value: "mySuperSecretPassword123"
};

const encryptedSetting = encryptStringValue(configSetting);
const decryptedSetting = decryptStringValue(encryptedSetting);

console.log(encryptedSetting); // { name: "password", value: "e45f" }
console.log(decryptedSetting); // { name: "password", value: "mySuperSecretPassword123" }
```

2. Managing world settings for a game:
```typescript
const worldSettingsConfig = {
  name: "worldSize",
  value: "large"
};

const worldSetting = createSettingFromConfig(worldSettingsConfig);
const updatedWorldSetting = updateWorldSettings(worldSetting);

console.log(worldSetting); // { name: "worldSize", value: "large" }
console.log(updatedWorldSetting); // { name: "worldSize", value: "updatedLargeSize" }
```

### Best Practices
- It is recommended to store sensitive data such as passwords in encrypted form to enhance security.
- Keep track of changes in settings by updating and managing them using the appropriate functions provided.

### uuid.ts

### Common Use Cases
1. **Validating and converting a string to UUID:**
```typescript
import { stringToUuid } from 'uuid';

const uuidString = "550e8400-e29b-41d4-a716-446655440000";
const uuidValue = stringToUuid(uuidString);

if (uuidValue) {
  console.log("Valid UUID value:", uuidValue);
} else {
  console.log("Invalid UUID value");
}
```

2. **Validating a UUID value:**
```typescript
import { validateUuid } from 'uuid';

const uuidValue = "123e4567-e89b-12d3-a456-426614174000";
const isValidUuid = validateUuid(uuidValue);

if (isValidUuid) {
  console.log("Valid UUID");
} else {
  console.log("Invalid UUID");
}
```

### Best Practices
- **Handle validation errors:** It is recommended to handle cases where the UUID validation fails, and provide appropriate feedback or error handling.
- **Use UUID values in the appropriate context:** Ensure that the UUID values are used in the correct context and adhere to UUID standards to avoid unexpected behavior.

### import.ts

### Common Use Cases
1. Importing multiple plugins from an array:
```typescript
import { handlePluginImporting } from './import';

const pluginsToImport = ['plugin1', 'plugin2', 'plugin3'];
handlePluginImporting(pluginsToImport)
  .then((importedPlugins) => {
    console.log(importedPlugins);
  })
  .catch((error) => {
    console.error(error);
  });
```

2. Lazy loading plugins in a component:
```typescript
import { handlePluginImporting } from './import';

const lazyLoadPlugin = async () => {
  const importedPlugin = await handlePluginImporting(['lazyPlugin']);
  const PluginComponent = importedPlugin[0].default;

  // Render PluginComponent in your application
};

lazyLoadPlugin();
```

### Best Practices
- **Keep plugin names consistent**: Ensure that the plugin names provided to `handlePluginImporting` are accurate and match the actual file names to avoid import errors.
- **Handle errors gracefully**: Utilize the `.catch` method when using `handlePluginImporting` to handle any errors that may occur during the import process.

### providers/facts.ts

### Common Use Cases
1. **Displaying Memory Facts:** This code can be used to format an array of Memory objects into a string that can then be displayed on a webpage or in an application.

   ```javascript
   import { formatFacts } from 'providers/facts';

   const facts = [
     { text: 'Fact 1' },
     { text: 'Fact 2' },
     { text: 'Fact 3' }
   ];

   const formattedFacts = formatFacts(facts);
   console.log(formattedFacts);
   // Output:
   // Fact 1
   // Fact 2
   // Fact 3
   ```

2. **Generating Fact Sheets:** The formatted string of Memory objects can be used to generate fact sheets or reports containing information from the Memory objects.

   ```javascript
   import { formatFacts } from 'providers/facts';

   const facts = fetchDataFromAPI(); // Assume this function fetches Memory objects from an API

   const formattedFacts = formatFacts(facts);
   generateFactSheet(formattedFacts);
   ```

### Best Practices
- **Validation:** It is important to validate the input array of Memory objects before passing it to the `formatFacts` function to ensure that it contains the required structure and properties.
  
- **Error Handling:** Implement error handling within the `formatFacts` function to handle scenarios where the input array is empty or does not contain valid Memory objects. This can prevent unexpected behavior or crashes in the application.

### providers/relationships.ts

### Common Use Cases
1. **Formatting Relationships**: 
   The code can be used to format relationships based on their interaction strength. For example, you can use this function to format relationships in a social networking platform where you want to display the strength of connections between users.

   ```typescript
   import { formatRelationships } from './providers/relationships';

   const relationships = [
       { userId: 1, strength: 'strong' },
       { userId: 2, strength: 'weak' }
   ];

   formatRelationships(runtimeInstance, relationships)
       .then((formattedRelationships) => {
           console.log(formattedRelationships);
       });
   ```

2. **Custom Relationship Formatting**: 
   You can modify the function to customize the formatting of relationships based on your specific requirements. This can be useful when you want to display relationships in a particular way depending on the context.

   ```typescript
   import { formatRelationships } from './providers/relationships';

   const relationships = [
       { userId: 1, strength: 'strong' },
       { userId: 2, strength: 'weak' }
   ];

   formatRelationships(runtimeInstance, relationships)
       .then((formattedRelationships) => {
           console.log("Formatted Relationships: ", formattedRelationships);
           // Perform custom actions based on the formatted relationships
       });
   ```

### Best Practices
- **Error Handling**: Ensure to handle any errors that may occur during the formatting process, such as invalid input or network issues, to provide a smooth user experience.
- **Modular Design**: Break down the formatting logic into smaller, reusable functions to promote code reusability and maintainability. This can help in scaling the application as the relationship formatting requirements evolve.

### actions/choice.ts

### Common Use Cases
1. **Simple Choice Selection**: This code can be used to create a simple choice selection system in a text-based game or interactive story.
   
   ```typescript
   import { getChoice } from './actions/choice';

   const choices = ['Option 1', 'Option 2', 'Option 3'];
   const selectedChoice = getChoice(choices);
   console.log(`You chose: ${selectedChoice}`);
   ```

2. **Decision Making in a Dialog System**: The code can also be used in a dialog system, where the user needs to make a decision based on the available choices.
   
   ```typescript
   import { getChoice } from './actions/choice';

   const dialogOptions = ['Say hello', 'Ask for help', 'Ignore'];
   const selectedOption = getChoice(dialogOptions);
   
   switch(selectedOption) {
       case 'Say hello':
           console.log('Hello!');
           break;
       case 'Ask for help':
           console.log('Can you help me?');
           break;
       case 'Ignore':
           console.log('Ignore the situation.');
           break;
   }
   ```

### Best Practices
- **Validation of Input**: Always validate the input choices to ensure that the selected choice is within the provided options.
- **Error Handling**: Implement error handling in case the user provides invalid input or cancels the selection process.

### actions/followRoom.ts

### Common Use Cases
1. Following a room in a chat application to receive notifications for new messages:
```typescript
import { followRoom } from './actions/followRoom';

const roomId = '1234';
const userId = '5678';

followRoom(roomId, userId);
```

2. Unfollowing a room in a chat application to stop receiving notifications for new messages:
```typescript
import { unfollowRoom } from './actions/followRoom';

const roomId = '1234';
const userId = '5678';

unfollowRoom(roomId, userId);
```

### Best Practices
- Ensure that the room ID and user ID are valid before calling the followRoom or unfollowRoom functions.
- Implement error handling to gracefully handle any issues that may arise during the follow/unfollow process.

### actions/muteRoom.ts

### Common Use Cases
1. Muting a chat room during a specific time period, such as during a presentation or a meeting.

```typescript
import { muteRoom } from './actions/muteRoom';

const roomName = 'Marketing';
const muteDuration = 30; // in minutes

muteRoom(roomName, muteDuration);
```

2. Temporarily muting notifications in a chat room to avoid distractions.

```typescript
import { muteRoom } from './actions/muteRoom';

const roomName = 'Engineering';
const muteDuration = 60; // in minutes

muteRoom(roomName, muteDuration);
```

### Best Practices
- Ensure to provide a valid `roomName` parameter to avoid errors.
- Use appropriate and meaningful `muteDuration` values to effectively mute the room for the desired duration.

### actions/reply.ts

### Common Use Cases
1. Sending a reply message in a chat application:
```typescript
import {reply} from './actions/reply';

const message = 'Hello! How can I help you today?';
reply(message);
```

2. Acknowledging receipt of a request in a customer service system:
```typescript
import {reply} from './actions/reply';

const request = 'Thank you for your inquiry. Our team is working on it!';
reply(request);
```

### Best Practices
- Ensure the message passed to the `reply` function is concise and clear for better communication with users.
- Use the `reply` function consistently to maintain a uniform response style throughout the application.

### actions/sendMessage.ts

### Common Use Cases
1. Sending a message to a user in a chat application.
```typescript
import sendMessage from './actions/sendMessage';

sendMessage('user123', 'Hello! How are you?');
```

2. Notifying a user with a custom message.
```typescript
import sendMessage from './actions/sendMessage';

sendMessage('user456', 'Your order has been shipped and will arrive tomorrow.');
```

### Best Practices
- Ensure the message being sent is relevant and appropriate for the recipient.
- Use error handling to handle cases where the message cannot be sent.

### actions/unfollowRoom.ts

### Common Use Cases
1. Unfollowing a room in a chat application when a user no longer wants to receive notifications or updates from that room.
```typescript
import { unfollowRoom } from './actions/unfollowRoom';

unfollowRoom(roomId, userId);
```

2. Implementing a feature to allow users to unfollow specific rooms in a forum or community platform.
```typescript
import { unfollowRoom } from './actions/unfollowRoom';

unfollowRoom(roomId, currentUser.id);
```

### Best Practices
- Ensure to include error handling in case the room or user ID provided is invalid.
- Consider implementing a confirmation dialog before allowing users to unfollow a room to prevent accidental unfollowing.

### actions/unmuteRoom.ts

### Common Use Cases
1. Muting multiple users simultaneously in a chat room
```typescript
import { unmuteRoom } from './actions/unmuteRoom';

const roomId = 'room123';
const usersToUnmute = ['user1', 'user2', 'user3'];

unmuteRoom(roomId, usersToUnmute);
```

2. Unmuting a single user in a private conversation room
```typescript
import { unmuteRoom } from './actions/unmuteRoom';

const roomId = 'privateRoom456';
const userToUnmute = 'user4';

unmuteRoom(roomId, [userToUnmute]);
```

### Best Practices
- Always provide the correct room ID when unmuting users to ensure the action is targeted accurately.
- Verify the status of the room and the user before attempting to unmute to avoid unnecessary API calls.

### actions/updateEntity.ts

### Common Use Cases
1. Update an entity in a database:
```typescript
import { updateEntity } from './actions/updateEntity';

// Assuming 'entityId' and 'updatedData' are already defined
updateEntity(entityId, updatedData);
```

2. Perform an entity update operation on a user action:
```typescript
import { updateEntity } from './actions/updateEntity';

function handleEntityUpdate(entityId: number, newData: any) {
  updateEntity(entityId, newData);
}
```

### Best Practices
- Ensure that the 'updateEntity' function is only called after validating the input data to prevent any potential errors.
- Consider incorporating error handling within the 'updateEntity' function to handle any failures gracefully.

### providers/capabilities.ts

### Common Use Cases
1. **Accessing Capability Data**: 
   - This code can be used to provide a centralized location for storing and retrieving capabilities for different components in an application. For example, a component may need to access a particular capability such as "payment" or "user authentication" to determine the actions it can perform.
   ```typescript
   import { capabilities } from './providers/capabilities';

   const hasPaymentCapability = capabilities.hasCapability('payment');
   if (hasPaymentCapability) {
       // Perform actions related to payment capability
   }
   ```

2. **Adding New Capabilities**:
   - This code can also be utilized to easily add new capabilities to the application without modifying multiple components. By updating the capabilities object in one place, the changes will be reflected across the application.
   ```typescript
   import { capabilities } from './providers/capabilities';

   capabilities.addCapability('inventoryManagement');
   ```

### Best Practices
- **Encapsulation**:
  - Encapsulating capabilities in a separate provider like this ensures that the code is modular and follows the principle of separation of concerns. Each component can access capabilities without needing to know the implementation details.
  
- **Consistent Use of Capabilities**:
  - It is advisable to establish a naming convention and consistent format for capabilities to avoid confusion and make it easier for developers to understand and use them in various parts of the application.

### providers/recentMessages.ts

### Common Use Cases
1. Displaying the most recent messages on a messaging application's homepage.
```typescript
import { getRecentMessages } from './providers/recentMessages';

const recentMessages = getRecentMessages();
// Display recentMessages on the homepage
```

2. Implementing a "recent activity" section on a dashboard to show the latest updates or interactions.
```typescript
import { getRecentMessages } from './providers/recentMessages';

const recentActivity = getRecentMessages();
// Display recentActivity on the dashboard to show the latest interactions
```

### Best Practices
- Ensure that the recent messages are fetched efficiently to avoid any performance issues on the application.
- Use proper error handling when fetching recent messages to provide a seamless user experience.

### providers/shouldRespond.ts

### Common Use Cases
1. **Check if a value meets a certain condition**: Use the `shouldRespond` function from the provided code to determine if a value should trigger a response based on a specified condition.
   
   Example:
   ```typescript
   import { shouldRespond } from './providers/shouldRespond';

   const value = 10;
   const condition = (val: number) => val > 5;

   if (shouldRespond(value, condition)) {
       console.log('This value triggers a response!');
   } else {
       console.log('No response needed.');
   }
   ```

2. **Filter an array based on a condition**: Utilize the `shouldRespond` function to filter an array based on a specified condition.
   
   Example:
   ```typescript
   import { shouldRespond } from './providers/shouldRespond';

   const numbers = [5, 10, 15, 20];
   const filteredNumbers = numbers.filter(num => shouldRespond(num, (val: number) => val > 10));

   console.log(filteredNumbers); // Output: [15, 20]
   ```

### Best Practices
- **Use descriptive condition functions**: When defining the condition function to be passed to `shouldRespond`, make sure it's descriptive and easy to understand.
- **Encapsulate reusable conditions**: If you find yourself using the same condition in multiple places, consider encapsulating it in a separate function for reusability.

### /home/runner/work/eliza/eliza/packages/core/__tests__/evaluators.test.ts

### Common Use Cases
1. Testing the evaluators function by running unit tests:
```typescript
import { evaluators } from '../src/evaluators';

test('should return the correct evaluator function', () => {
  const evaluatorFunc = evaluators('addition');
  expect(typeof evaluatorFunc).toBe('function');
  expect(evaluatorFunc(2, 3)).toBe(5);
});
```

2. Checking if the evaluators function returns undefined for an unknown evaluator:
```typescript
import { evaluators } from '../src/evaluators';

test('should return undefined for unknown evaluator', () => {
  const evaluatorFunc = evaluators('unknown');
  expect(evaluatorFunc).toBeUndefined();
});
```

### Best Practices
- Ensure to cover edge cases in your unit tests to have comprehensive test coverage.
- Consider using mocking or stubbing techniques if the evaluators function relies on external dependencies for better isolated testing.

### /home/runner/work/eliza/eliza/packages/core/__tests__/mockCharacter.ts

### Common Use Cases
1. One use case for this mockCharacter.ts file could be testing the functionality of a character component in a game application. By using the mock character data provided in this file, developers can simulate different scenarios and test the behavior of the character component.
```typescript
import { mockCharacter } from '/home/runner/work/eliza/eliza/packages/core/__tests__/mockCharacter';

// Use the mock character data to initialize a character component for testing
const character = new Character(mockCharacter);
character.attack();
```

2. Another use case could be creating a UI component that displays character information based on the data provided in the mockCharacter.ts file. This can be useful for prototyping or building out the UI of a game interface.
```typescript
import { mockCharacter } from '/home/runner/work/eliza/eliza/packages/core/__tests__/mockCharacter';

// Display the character information on the UI using the mock character data
console.log(`Character Name: ${mockCharacter.name}`);
console.log(`Character Health: ${mockCharacter.health}`);
```

### Best Practices
- When using the mockCharacter data for testing, make sure to cover edge cases and possible scenarios to ensure the reliability of the component being tested.
- Consider creating multiple mock character data sets to test different aspects of the character component, such as different levels, abilities, or status effects.

### /home/runner/work/eliza/eliza/packages/core/__tests__/runtime.test.ts

**Common Use Cases**
1. Perform unit testing to ensure the runtime functionality works as expected:
```typescript
test('runtime should return correct response for given input', () => {
  const input = 'Hello, Eliza!';
  const expectedOutput = 'Hi, how can I help you today?';
  
  const response = runtime(input);
  
  expect(response).toEqual(expectedOutput);
});
```

2. Check for edge cases and handle errors within the runtime function:
```typescript
test('runtime should handle empty input and return default response', () => {
  const input = '';
  const expectedOutput = 'I'm sorry, I did not understand that. Can you please provide more information?';
  
  const response = runtime(input);
  
  expect(response).toEqual(expectedOutput);
});
```

**Best Practices**
- Ensure to cover all possible scenarios in the unit tests to validate the robustness of the runtime function.
- Use descriptive test names that clearly explain the scenario being tested for better readability and maintainability of the test suite.

### actions/ignore.ts

### Common Use Cases
1. Ignoring specific files or directories in the project when running certain actions or commands.
   
   ```typescript
   // Ignore a specific file
   ignore.add('fileToIgnore.txt');

   // Ignore a directory
   ignore.add('dirToIgnore/');
   ```

2. Setting up a global ignore list for certain actions or commands to exclude files or directories that are not needed for the operation.

   ```typescript
   // Ignore multiple files
   ignore.add(['file1.txt', 'file2.txt']);

   // Ignore directories and subdirectories
   ignore.add(['dir1/', 'dir2/']);
   ```

### Best Practices
- Ensure that the files or directories being ignored are not crucial for the operation to prevent accidental exclusions.
- Keep the ignore list concise and specific to avoid overlooking important files or directories.

### actions/none.ts

### Common Use Cases
1. Triggering an action that performs no specific operation.
```typescript
import { createAction } from 'redux-actions';

const doNothing = createAction('DO_NOTHING');

dispatch(doNothing());
```

2. Placeholder action for testing and development purposes.
```typescript
import { createAction } from 'redux-actions';

const mockAction = createAction('MOCK_ACTION');

dispatch(mockAction());
```

### Best Practices
- It is recommended to use a more descriptive action type for actions that actually perform a specific operation, rather than using this generic "none" action.
- Use the "none" action sparingly and only when necessary, as it can lead to confusion in the codebase if overused.

### providers/actions.ts

### Common Use Cases
1. Fetching data from an API and updating the state in a React component:
```jsx
import { fetchData } from './providers/actions';

const fetchDataAndUpdateState = async () => {
  const data = await fetchData();
  // Update state in component with fetched data
}
```

2. Updating data in a Redux store using the provided actions:
```jsx
import { updateData } from './providers/actions';

const updateDataInStore = (newData) => {
  updateData(newData);
}
```

### Best Practices
- Make sure to handle any errors that may occur during the data fetching or updating process.
- Keep the actions file well-organized by grouping related actions together for easier maintenance.

### providers/anxiety.ts

### Common Use Cases
1. Use the `AnxietyProvider` to provide the anxiety state and functions related to anxiety management to multiple components within a React application.

```jsx
// App.js
import React from 'react';
import { AnxietyProvider } from './providers/anxiety';
import Header from './components/Header';
import Content from './components/Content';

function App() {
  return (
    <AnxietyProvider>
      <Header />
      <Content />
    </AnxietyProvider>
  );
}

export default App;
```

2. Utilize the `useAnxiety` hook within a component to access the anxiety state and functions for managing anxiety-related data.

```jsx
// MyComponent.js
import React from 'react';
import { useAnxiety } from '../providers/anxiety';

const MyComponent = () => {
  const { anxietyLevel, increaseAnxiety, decreaseAnxiety } = useAnxiety();

  return (
    <div>
      <h2>Anxiety Level: {anxietyLevel}</h2>
      <button onClick={increaseAnxiety}>Increase Anxiety</button>
      <button onClick={decreaseAnxiety}>Decrease Anxiety</button>
    </div>
  );
}

export default MyComponent;
```

### Best Practices
- Ensure that the `AnxietyProvider` is placed at a high level in the component hierarchy to provide anxiety state and functions to all components that need access to them.
- Follow a consistent naming convention for the anxiety-related functions and state variables to maintain clarity and consistency in the codebase.

### providers/attachments.ts

### Common Use Cases
1. Accessing the list of attachments for a specific item:
```javascript
import { getAttachments } from './providers/attachments';

const itemAttachments = getAttachments('item123');
console.log(itemAttachments);
```

2. Uploading a new attachment for a specific item:
```javascript
import { uploadAttachment } from './providers/attachments';

const newAttachment = { item: 'item123', name: 'newFile.pdf' };
const result = uploadAttachment(newAttachment);
console.log(result);
```

### Best Practices
- Ensure to handle errors and edge cases when using the attachment provider functions.
- Implement proper authorization checks before accessing or uploading attachments to prevent unauthorized access.

### providers/character.ts

### Common Use Cases
1. **Rendering a character card:** 
   This code can be used to define a character object with properties such as name, age, and occupation. This object can then be used to render a character card in a user interface.

   ```typescript
   import { Character } from '../providers/character';

   const character: Character = {
       name: 'Jon Snow',
       age: 23,
       occupation: 'King in the North'
   };
   ```

2. **Filtering characters by occupation:** 
   This code can also be used to filter an array of character objects based on their occupation. This can be helpful in scenarios where a user wants to view only characters with a specific occupation.

   ```typescript
   import { Character } from '../providers/character';

   const characters: Character[] = [
       { name: 'Daenerys Targaryen', age: 25, occupation: 'Queen' },
       { name: 'Tyrion Lannister', age: 40, occupation: 'Hand of the Queen' },
       { name: 'Sansa Stark', age: 20, occupation: 'Lady of Winterfell' }
   ];

   const filteredCharacters = characters.filter(character => character.occupation === 'Queen');
   ```

### Best Practices
- **Use TypeScript interfaces for type checking**: When defining data structures like the `Character` object, it is recommended to use TypeScript interfaces for type checking and better code readability.
- **Encapsulate data manipulation logic**: Consider encapsulating data manipulation logic related to characters within a separate service or provider to keep the code modular and maintainable.

### providers/entities.ts

### Common Use Cases
1. **Creating Entities:** The code can be used to define different types of entities within a system, such as users, products, orders, etc.

```typescript
// Define a User entity
export interface User {
  id: number;
  name: string;
  email: string;
}

// Define a Product entity
export interface Product {
  id: number;
  name: string;
  price: number;
}
```

2. **Accessing Entities in Components:** The defined entities can be imported and used in various components of an application.

```typescript
import { User, Product } from './providers/entities';

const user: User = {
  id: 1,
  name: 'John Doe',
  email: 'john.doe@example.com'
};

const product: Product = {
  id: 123,
  name: 'Laptop',
  price: 999.99
};
```

### Best Practices
- **Separation of Concerns:** Keep entity definitions in a separate file like providers/entities.ts to maintain a clean and organized codebase.
- **Consistent Naming Conventions:** Use meaningful and consistent names for entities to improve code readability and maintainability.

### providers/knowledge.ts

### Common Use Cases
1. **Accessing Knowledge Data**: 
   ```typescript
   import { getKnowledgeData } from './providers/knowledge';

   const allKnowledgeData = getKnowledgeData();
   console.log(allKnowledgeData);
   ```

2. **Filtering Knowledge Data**:
   ```typescript
   import { getKnowledgeData } from './providers/knowledge';

   const filteredKnowledge = getKnowledgeData().filter(knowledge => knowledge.category === 'Javascript');
   console.log(filteredKnowledge);
   ```

### Best Practices
- **Separation of Concerns**: Keep the knowledge data and retrieval logic separate from the components that use it to maintain a clean and modular codebase.
- **Error Handling**: Implement error handling in the data retrieval functions to ensure that the application can handle any potential data access issues effectively.

### providers/providers.ts

### Common Use Cases
1. **Accessing Provider Data**: One common use case for the provided code would be accessing data from a provider in different components of an application. By defining providers in the providers.ts file, various components can access the data provided by these providers.

```typescript
// In a component that needs access to provider data
import { Injectable } from './providers/providers';

@Injectable()
export class ExampleComponent {
    constructor(private providerService: ProviderService) {
        this.providerData = this.providerService.getData();
    }
}
```

2. **Sharing Data between Components**: Another use case could be sharing data between multiple components using providers. Providers can be used as a centralized point for sharing data and managing state across different parts of an application.

```typescript
// In a component that needs to share data with another component
import { Injectable } from './providers/providers';

@Injectable()
export class DataService {
    private sharedData: any;

    setSharedData(data: any) {
        this.sharedData = data;
    }

    getSharedData(): any {
        return this.sharedData;
    }
}
```

### Best Practices
- **Separation of Concerns**: It is best practice to separate the concerns of data management and business logic by using providers. This helps in maintaining a clean and organized code structure.
  
- **Dependency Injection**: When using providers, make sure to utilize Angular's dependency injection system to inject the required dependencies into the components. This ensures that components are loosely coupled and easier to test.

### providers/roles.ts

### Common Use Cases
1. **Get all roles:** Retrieve a list of all available roles from the provider.
   ```typescript
   import { getAllRoles } from './providers/roles';

   const roles = getAllRoles();
   console.log(roles);
   ```

2. **Get specific role by ID:** Retrieve a specific role by its ID.
   ```typescript
   import { getRoleById } from './providers/roles';

   const roleId = '123';
   const role = getRoleById(roleId);
   console.log(role);
   ```

### Best Practices
- **Document role names:** Make sure to provide clear documentation for each role to explain their purpose and permissions.
- **Error handling:** Implement proper error handling in case a role is not found or an unexpected error occurs.

### providers/time.ts

### Common Use Cases
1. Using the `formatTime` function to display the current time in a specific format on a webpage.
```typescript
import { formatTime } from './providers/time';

const currentTime = new Date();
const formattedTime = formatTime(currentTime, 'hh:mm:ss');
console.log(formattedTime); // Output: 12:30:45
```

2. Building a time management application that utilizes the `getQuarter` function to determine the quarter of the year.
```typescript
import { getQuarter } from './providers/time';

const currentDate = new Date();
const quarter = getQuarter(currentDate.getMonth());
console.log(`Current quarter: ${quarter}`); // Output: Current quarter: Q3
```

### Best Practices
- Ensure to pass valid Date objects to functions in order to prevent errors.
- Use the code in a way that promotes reusability and modular design.

## FAQ
### Q: How do I define and use a new Action in @elizaos/core?
To define a new Action, you need to specify an action object with a unique name, a description explaining its purpose, a validate function to check its applicability, and a handler for executing the action. Once defined, integrate it with the AgentRuntime to ensure it responds to the appropriate triggers.

### Q: My action is registered, but the agent is not calling it.
Ensure that action's name clearly aligns with the task, and ensure you give a detailed description of the conditions that should trigger the action. Also, verify that all parts of the action, including the validate and handler functions, are correctly implemented.

### Q: Can Providers be used to access external API data?
Yes, Providers in @elizaos/core are designed to interact with various external systems, which includes fetching data from external APIs. This enables the agent to incorporate real-time, dynamic context into its interactions.

### Q: How do I extend the evaluation capabilities of the agent?
To extend the agent's evaluation capabilities, you can implement additional evaluators that integrate with the AgentRuntime. These evaluators can be customized to extract and assess specific information from conversation data, enhancing the agent's ability to build long-term memory and contextual awareness.

### Q: How can I create a mock environment for testing?
You can use the MockDatabaseAdapter class which extends the DatabaseAdapter. This allows you to simulate database interactions without requiring an actual database connection, providing a controlled test environment for your agent's functionality.

### Q: How do I manage entity-specific tasks in a room?
Use functions provided by classes such as MockDatabaseAdapter to interact with entities in specific rooms. For instance, the getEntitiesForRoom method retrieves entities for a given room, enabling you to manage or categorize entities for specific tasks.

## Development

### TODO Items
### Items
1. Add ability for plugins to register their sources
   - Context: This todo is related to exporting a default sendMessageAction.
   - Type: feature
2. These are okay but not great
   - Context: This todo is related to returning formatted posts joined by a newline.
   - Type: enhancement
3. Get the server id, create it or whatever
   - Context: This todo is related to creating a room with a specific world id, name, and server id.
   - Type: bug
4. This could all be rewritten like an ensureConnection approach
   - Context: This todo is related to sending a message with specific details to participants in a room.
   - Type: enhancement

## Troubleshooting Guide
### Agent Runtime is not responding to certain triggers.
- Cause: The issue could be due to improperly defined action handlers or validate functions.
- Solution: Double-check that the validate functions are correctly implemented and conditions for triggers are met. Also, ensure handlers are accurately executing the intended task.

### Data from the provider is outdated or incorrect.
- Cause: This might be due to a lack of proper integration with external data sources or API failures.
- Solution: Verify the API connections and ensure that the provider's get function is fetching data accurately. Recheck network configurations if necessary.

### Evaluator fails to maintain contextual awareness.
- Cause: The evaluator might not be capturing required facts or relationships correctly.
- Solution: Review the evaluator's configurations and make sure it is leveraging the correct data from the AgentRuntime. Also, ensure it is updated with the latest configuration needed for accurate context maintenance.

### Debugging Tips
- Check console logs for any errors during action validation and handler execution.
- Use mock classes for simulating environments and isolate functions to test specific agent behaviors.
- Ensure the agent runtime is loaded with correct configurations and understands the structure it interacts with.