/**
 * Services exports for the ElizaOS server
 */

// Message bus (internal event system)
export { default as internalMessageBus } from './message-bus';

// Message service and plugin
export {
  MessageBusService,
  messageBusConnectorPlugin,
  setGlobalElizaOS,
  setGlobalAgentServer,
  type MessageServiceMessage,
} from './message';

// Character loader
export {
  tryLoadFile,
  loadCharactersFromUrl,
  jsonToCharacter,
  loadCharacter,
  loadCharacterTryPath,
  hasValidRemoteUrls,
  loadCharacters,
} from './loader';
