import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { 
  IAgentRuntime, 
  Memory, 
  State,
  Plugin,
  ComponentDefinition
} from '@elizaos/core';
import { configurationDemoPlugin } from '../index';

// Mock runtime for testing
function createMockRuntime(): IAgentRuntime {
  const mockConfigManager = {
    isComponentEnabled: vi.fn(),
    initializeUnifiedPluginConfiguration: vi.fn(),
    getEnabledComponentsMap: vi.fn(() => new Map()),
    validateComponentDependencies: vi.fn(() => ({ valid: true, errors: [], warnings: [] }))
  };

  return {
    agentId: 'test-agent',
    character: { name: 'TestAgent', bio: ['Test bio'] },
    getConfigurationManager: vi.fn(() => mockConfigManager),
    createMemory: vi.fn(),
    actions: [],
    providers: [],
    evaluators: []
  } as any;
}

function createMockMessage(): Memory {
  return {
    id: 'test-message',
    entityId: 'test-user',
    roomId: 'test-room', 
    content: { text: 'hello world', source: 'test' },
    createdAt: Date.now()
  } as Memory;
}

function createMockState(): State {
  return {
    values: {},
    data: {},
    text: ''
  } as State;
}

describe('Configuration Demo Plugin', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime = createMockRuntime();
    mockMessage = createMockMessage();
    mockState = createMockState();
  });

  it('should have correct plugin structure', () => {
    expect(configurationDemoPlugin.name).toBe('@elizaos/plugin-configuration-demo');
    expect(configurationDemoPlugin.description).toContain('dynamic plugin configuration system');
    expect(configurationDemoPlugin.config?.defaultEnabled).toBe(true);
    expect(configurationDemoPlugin.config?.category).toBe('demo');
  });

  it('should have unified components array', () => {
    expect(configurationDemoPlugin.components).toBeDefined();
    expect(Array.isArray(configurationDemoPlugin.components)).toBe(true);
    expect(configurationDemoPlugin.components!.length).toBe(5);
  });

  it('should have legacy actions for backwards compatibility', () => {
    expect(configurationDemoPlugin.actions).toBeDefined();
    expect(Array.isArray(configurationDemoPlugin.actions)).toBe(true);
    expect(configurationDemoPlugin.actions!.length).toBe(1);
    expect(configurationDemoPlugin.actions![0].name).toBe('LEGACY_GREETING');
  });

  it('should define components with proper structure', () => {
    const components = configurationDemoPlugin.components as ComponentDefinition[];
    
    // Check each component has required fields
    for (const component of components) {
      expect(component.type).toMatch(/^(action|provider|evaluator)$/);
      expect(component.component).toBeDefined();
      expect(component.component.name).toBeDefined();
      expect(component.config).toBeDefined();
      expect(typeof component.config!.defaultEnabled).toBe('boolean');
    }
  });

  it('should have properly configured default enabled states', () => {
    const components = configurationDemoPlugin.components as ComponentDefinition[];
    
    // Check specific components have correct default states
    const greetingAction = components.find(c => c.component.name === 'CONFIGURABLE_GREETING');
    expect(greetingAction?.config?.defaultEnabled).toBe(true);
    
    const riskyAction = components.find(c => c.component.name === 'RISKY_OPERATION');
    expect(riskyAction?.config?.defaultEnabled).toBe(false);
    expect(riskyAction?.config?.disabledReason).toContain('Risky operation');
    
    const expensiveProvider = components.find(c => c.component.name === 'EXPENSIVE_DATA');
    expect(expensiveProvider?.config?.defaultEnabled).toBe(false);
    expect(expensiveProvider?.config?.disabledReason).toContain('Expensive operation');
  });

  it('should initialize correctly and log component status', async () => {
    const configManager = mockRuntime.getConfigurationManager();
    
    // Mock configuration status
    configManager.isComponentEnabled
      .mockReturnValueOnce(true)  // CONFIGURABLE_GREETING
      .mockReturnValueOnce(false) // RISKY_OPERATION  
      .mockReturnValueOnce(true)  // CONFIGURABLE_TIME
      .mockReturnValueOnce(false) // EXPENSIVE_DATA
      .mockReturnValueOnce(true); // CONFIGURABLE_EVALUATOR

    // Mock console.log to capture output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    await configurationDemoPlugin.init!({}, mockRuntime);

    expect(consoleSpy).toHaveBeenCalledWith('Configuration Demo Plugin initialized');
    expect(consoleSpy).toHaveBeenCalledWith('Plugin has 5 configurable components');
    
    // Verify component status was logged
    expect(configManager.isComponentEnabled).toHaveBeenCalledTimes(5);
    expect(consoleSpy).toHaveBeenCalledWith('Component CONFIGURABLE_GREETING (action): ENABLED');
    expect(consoleSpy).toHaveBeenCalledWith('Component RISKY_OPERATION (action): DISABLED');
    
    consoleSpy.mockRestore();
  });

  describe('Configurable Greeting Action', () => {
    it('should validate correctly', async () => {
      const components = configurationDemoPlugin.components as ComponentDefinition[];
      const greetingAction = components.find(c => c.component.name === 'CONFIGURABLE_GREETING');
      expect(greetingAction).toBeDefined();
      
      const action = greetingAction!.component as any;
      
      // Should validate when message contains 'hello'
      mockMessage.content.text = 'hello there';
      const result = await action.validate(mockRuntime, mockMessage);
      expect(result).toBe(true);
      
      // Should not validate otherwise
      mockMessage.content.text = 'goodbye';
      const result2 = await action.validate(mockRuntime, mockMessage);
      expect(result2).toBe(false);
    });

    it('should execute correctly when enabled', async () => {
      const components = configurationDemoPlugin.components as ComponentDefinition[];
      const greetingAction = components.find(c => c.component.name === 'CONFIGURABLE_GREETING');
      const action = greetingAction!.component as any;
      
      const mockCallback = vi.fn();
      
      const result = await action.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);
      
      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Hello! This is a configurable greeting action'),
        thought: 'Executed configurable greeting action',
        actions: ['CONFIGURABLE_GREETING']
      });
      
      expect(result.values.greetingExecuted).toBe(true);
    });
  });

  describe('Risky Operation Action', () => {
    it('should be disabled by default with proper reason', () => {
      const components = configurationDemoPlugin.components as ComponentDefinition[];
      const riskyAction = components.find(c => c.component.name === 'RISKY_OPERATION');
      
      expect(riskyAction?.config?.defaultEnabled).toBe(false);
      expect(riskyAction?.config?.experimental).toBe(true);
      expect(riskyAction?.config?.permissions).toContain('admin_operations');
      expect(riskyAction?.config?.disabledReason).toContain('Risky operation');
    });
  });

  describe('Configurable Time Provider', () => {
    it('should provide time information', async () => {
      const components = configurationDemoPlugin.components as ComponentDefinition[];
      const timeProvider = components.find(c => c.component.name === 'CONFIGURABLE_TIME');
      const provider = timeProvider!.component as any;
      
      const result = await provider.get(mockRuntime, mockMessage, mockState);
      
      expect(result.text).toContain('CONFIGURABLE TIME');
      expect(result.text).toContain('Current time:');
      expect(result.values.currentTime).toBeDefined();
      expect(result.values.timestamp).toBeDefined();
    });
  });

  describe('Expensive Data Provider', () => {
    it('should be disabled by default', () => {
      const components = configurationDemoPlugin.components as ComponentDefinition[];
      const expensiveProvider = components.find(c => c.component.name === 'EXPENSIVE_DATA');
      
      expect(expensiveProvider?.config?.defaultEnabled).toBe(false);
      expect(expensiveProvider?.config?.disabledReason).toContain('Expensive operation');
      expect(expensiveProvider?.config?.permissions).toContain('external_access');
    });

    it('should simulate expensive operation when enabled', async () => {
      const components = configurationDemoPlugin.components as ComponentDefinition[];
      const expensiveProvider = components.find(c => c.component.name === 'EXPENSIVE_DATA');
      const provider = expensiveProvider!.component as any;
      
      const startTime = Date.now();
      const result = await provider.get(mockRuntime, mockMessage, mockState);
      const endTime = Date.now();
      
      // Should take some time (simulated expensive operation)
      expect(endTime - startTime).toBeGreaterThanOrEqual(90);
      
      expect(result.text).toContain('EXPENSIVE DATA');
      expect(result.values.expensiveData.cost).toBe('high');
    });
  });

  describe('Legacy Action Compatibility', () => {
    it('should have legacy action that works independently', async () => {
      const legacyAction = configurationDemoPlugin.actions![0];
      
      expect(legacyAction.name).toBe('LEGACY_GREETING');
      
      // Test validation
      mockMessage.content.text = 'legacy hello';
      const isValid = await legacyAction.validate!(mockRuntime, mockMessage);
      expect(isValid).toBe(true);
      
      // Test handler
      const mockCallback = vi.fn();
      await legacyAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);
      
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'This is a legacy greeting action - always enabled!',
        actions: ['LEGACY_GREETING']
      });
    });
  });
});

export { configurationDemoPlugin };