import { createEntityAction, createRelationshipAction, queryRelationshipsAction } from './packages/plugin-rolodx/src/actions/index.js';

// Mock runtime
const mockRuntime = {
  agentId: 'test-agent',
  
  // Mock entity methods
  async createEntity(entity) {
    console.log('Creating entity:', entity);
    return 'entity-' + Date.now();
  },
  
  async getEntityById(id) {
    return { id, names: ['Test Entity'] };
  },
  
  async getAllEntities(agentId) {
    return [
      { id: 'alice-123', names: ['Alice Chen'], metadata: { title: 'CTO' } },
      { id: 'bob-456', names: ['Bob Martinez'], metadata: { title: 'Research Lead' } }
    ];
  },
  
  // Mock relationship methods
  async createRelationship(rel) {
    console.log('Creating relationship:', rel);
    return true;
  },
  
  async getRelationships(params) {
    return [
      {
        sourceEntityId: 'alice-123',
        targetEntityId: 'bob-456',
        tags: ['colleague', 'reports-to']
      }
    ];
  },
  
  // Mock memory methods
  async createMemory(memory, table) {
    console.log('Creating memory:', memory.content.text);
    return 'memory-' + Date.now();
  },
  
  // Mock LLM
  async useModel(modelType, params) {
    if (params.prompt.includes('extract entities')) {
      return JSON.stringify([
        {
          name: 'Alice Chen',
          type: 'person',
          title: 'CTO',
          organization: 'TechCorp'
        }
      ]);
    } else if (params.prompt.includes('extract relationships')) {
      return JSON.stringify([
        {
          entity1: 'Alice Chen',
          entity2: 'Bob Martinez',
          relationship_type: 'colleague',
          strength: 0.8
        }
      ]);
    }
    return 'Mock response';
  },
  
  logger: {
    info: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.log
  }
};

// Mock message
const mockMessage = {
  entityId: 'user-123',
  roomId: 'room-456',
  content: {
    text: 'Alice Chen is the CTO of TechCorp and reports to Bob Martinez who is the Research Lead'
  }
};

// Mock state
const mockState = {
  values: {},
  data: {},
  text: mockMessage.content.text
};

// Mock callback
const mockCallback = async (response) => {
  console.log('Action response:', response.text);
  return [];
};

async function testActions() {
  console.log('Testing CREATE_ENTITY action...');
  
  // Test CREATE_ENTITY
  const entityValid = await createEntityAction.validate(mockRuntime, mockMessage, mockState);
  console.log('CREATE_ENTITY validation:', entityValid);
  
  if (entityValid) {
    try {
      const entityResult = await createEntityAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);
      console.log('CREATE_ENTITY result:', entityResult);
    } catch (error) {
      console.error('CREATE_ENTITY error:', error.message);
    }
  }
  
  console.log('\nTesting CREATE_RELATIONSHIP action...');
  
  // Test CREATE_RELATIONSHIP
  const relValid = await createRelationshipAction.validate(mockRuntime, mockMessage, mockState);
  console.log('CREATE_RELATIONSHIP validation:', relValid);
  
  if (relValid) {
    try {
      const relResult = await createRelationshipAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);
      console.log('CREATE_RELATIONSHIP result:', relResult);
    } catch (error) {
      console.error('CREATE_RELATIONSHIP error:', error.message);
    }
  }
  
  console.log('\nTesting QUERY_RELATIONSHIPS action...');
  
  // Test QUERY_RELATIONSHIPS
  const queryValid = await queryRelationshipsAction.validate(mockRuntime, mockMessage, mockState);
  console.log('QUERY_RELATIONSHIPS validation:', queryValid);
  
  if (queryValid) {
    try {
      const queryResult = await queryRelationshipsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);
      console.log('QUERY_RELATIONSHIPS result:', queryResult);
    } catch (error) {
      console.error('QUERY_RELATIONSHIPS error:', error.message);
    }
  }
}

testActions().catch(console.error);