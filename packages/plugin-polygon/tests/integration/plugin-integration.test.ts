import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PolygonPlugin from '../../src/index';
import { mockRuntime } from '../../vitest.setup';

// Import mocks from centralized setup
import '../../vitest.setup';

describe('Polygon Plugin Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Spy on the runtime methods
    vi.spyOn(mockRuntime, 'getConfig').mockImplementation((key, defaultValue) => {
      const configs = {
        'polygon.privateKey': '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        'polygon.ethereumRpcUrl': 'https://mainnet.infura.io/v3/mock-key',
        'polygon.polygonRpcUrl': 'https://polygon-mainnet.infura.io/v3/mock-key',
        'polygon.polygonscanKey': 'MOCK_POLYGONSCAN_KEY',
      };
      return configs[key] || defaultValue;
    });
    
    vi.spyOn(mockRuntime, 'registerAction');
    vi.spyOn(mockRuntime, 'registerService');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Plugin Initialization', () => {
    it('should initialize plugin with all services', async () => {
      // Create plugin instance and initialize
      const plugin = new PolygonPlugin();
      await plugin.init({
        PRIVATE_KEY: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        ETHEREUM_RPC_URL: 'https://mainnet.infura.io/v3/mock-key',
        POLYGON_RPC_URL: 'https://polygon-mainnet.infura.io/v3/mock-key',
        POLYGONSCAN_KEY: 'MOCK_POLYGONSCAN_KEY',
      }, mockRuntime);

      // Register actions and services
      plugin.getActions().forEach(action => {
        mockRuntime.registerAction(action.name, action.handler);
      });

      plugin.getServices().forEach(ServiceClass => {
        mockRuntime.registerService(ServiceClass.serviceType, {});
      });

      // Verify all services were registered
      expect(mockRuntime.registerService).toHaveBeenCalledTimes(3); // 3 services in the plugin
      
      // Verify the specific services
      expect(mockRuntime.registerService).toHaveBeenCalledWith(
        'polygonRpc',
        expect.anything()
      );
      
      expect(mockRuntime.registerService).toHaveBeenCalledWith(
        'polygonBridge',
        expect.anything()
      );
      
      expect(mockRuntime.registerService).toHaveBeenCalledWith(
        'heimdall',
        expect.anything()
      );
    });
    
    it('should register all actions', async () => {
      // Create plugin instance and initialize
      const plugin = new PolygonPlugin();
      await plugin.init({
        PRIVATE_KEY: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        ETHEREUM_RPC_URL: 'https://mainnet.infura.io/v3/mock-key',
        POLYGON_RPC_URL: 'https://polygon-mainnet.infura.io/v3/mock-key',
        POLYGONSCAN_KEY: 'MOCK_POLYGONSCAN_KEY',
      }, mockRuntime);

      // Register actions
      plugin.getActions().forEach(action => {
        mockRuntime.registerAction(action.name, action.handler);
      });
      
      // Verify various actions are registered
      expect(mockRuntime.registerAction).toHaveBeenCalled();
      
      // Check for specific actions
      const actionNames = vi.mocked(mockRuntime.registerAction).mock.calls.map(call => call[0]);
      
      expect(actionNames).toContain('BRIDGE_DEPOSIT_POLYGON');
      expect(actionNames).toContain('DELEGATE_L1');
      expect(actionNames).toContain('GET_VALIDATOR_INFO');
      expect(actionNames).toContain('GET_DELEGATOR_INFO');
      expect(actionNames).toContain('GET_CHECKPOINT_STATUS');
    });
    
    it('should initialize with default RPC URLs when not provided', async () => {
      // Create plugin instance and initialize
      const plugin = new PolygonPlugin();
      await plugin.init({
        PRIVATE_KEY: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        // No RPC URLs provided
        POLYGONSCAN_KEY: 'MOCK_POLYGONSCAN_KEY',
      }, mockRuntime);

      // Plugin should still initialize with default URLs
      expect(plugin.config?.POLYGON_RPC_URL).toBeDefined();
      expect(plugin.config?.ETHEREUM_RPC_URL).toBeDefined();
    });
    
    it('should throw error when private key is missing', async () => {
      // Create plugin instance
      const plugin = new PolygonPlugin();
      
      // Try to initialize without private key, should throw
      await expect(plugin.init({
        // No private key
        ETHEREUM_RPC_URL: 'https://mainnet.infura.io/v3/mock-key',
        POLYGON_RPC_URL: 'https://polygon-mainnet.infura.io/v3/mock-key',
        POLYGONSCAN_KEY: 'MOCK_POLYGONSCAN_KEY',
      }, mockRuntime)).rejects.toThrow();
    });
  });
}); 