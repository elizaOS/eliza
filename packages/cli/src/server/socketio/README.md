# WebSocket Message Flow

This document outlines the complete end-to-end flow of messages between users and agents using WebSockets.

## Architecture Overview

Our WebSocket implementation uses a unified `WebSocketService` that is used by both clients and agents. This ensures that messaging is handled consistently regardless of the sender or receiver.

## Implementation Details

### Key Components

1. **WebSocketService**: Core implementation that handles message sending and receiving
2. **WebSocketFactory**: Factory class that creates and manages WebSocketService instances
3. **SocketIOManager**: Client-side manager that interfaces with the WebSocketService

### Recent Improvements

1. **Enhanced Self-Message Prevention**:
   - Multiple safeguards to prevent message loops
   - Clear identity checks at multiple processing stages
   - Extracted identity checks into helper methods

2. **Better Message Format Handling**:
   - Support for both `text` and `message` fields
   - Standardized field usage across components
   - Clear documentation about field naming conventions

3. **Improved Error Handling**:
   - Content validation before processing
   - Try/catch blocks around critical operations
   - Extracted LLM calls into a separate method with error handling

4. **Code Organization**:
   - Moved validation logic to dedicated methods
   - Improved TypeScript types and interfaces
   - Better code modularity

## Message Flow Sequence

### 1. User Sends a Message

1. Client application calls `SocketIOManager.sendMessage()`
2. SocketIOManager retrieves the appropriate WebSocketService for the room
3. WebSocketService formats the message and sends it via socket.io
4. Message is broadcast to all clients in the room

### 2. Agent Receives the Message

1. Agent's WebSocketService receives the message via socket.io
2. Service validates the message and checks it's not from itself (`validateMessagePayload` and `isSelfMessage`)
3. If message passes verification, it emits a 'textMessage' event and calls `processAgentMessage()`

### 3. Agent Processes the Message

1. Agent creates a memory entry for the received message
2. Uses its runtime to compose the conversational state
3. Calls `useModelWithErrorHandling` to get a response from the LLM
4. Creates a memory entry for its response
5. Sends the response back via WebSocket
6. Evaluates the interaction

### 4. User Receives Agent's Response

1. Client's WebSocketService receives the message
2. Verifies it's not from itself (by comparing senderId)
3. Emits a 'messageBroadcast' event for the UI to display the message

## Field Naming Consistency

- We support both `text` and `message` fields for backward compatibility
- Within WebSocket payloads, we use `message` as the primary field
- In the UI and memory systems, we use `text` as the primary field

## Error Handling

- Messages with missing required fields are logged and ignored
- LLM errors are caught and logged
- Failed connections attempt to reconnect automatically

## Self-Message Prevention

We have multiple safeguards to prevent agents from receiving and processing their own messages:

1. In `handleIncomingMessage()`: Uses `validateMessagePayload` and `isSelfMessage` helper methods
2. Centralized message validation with clear error reporting
3. On the client side: Only processes messages where senderId is different from the client's ID

This ensures that messages don't cause echo effects or infinite loops between agents. 