/**
 * Plugin Configuration System Integration Test Scenario
 * Tests complete plugin lifecycle with real services, actions, providers, and evaluators
 * Validates environment variable handling and component hot-swap functionality
 */

import { Service } from '@elizaos/core';
import type { 
  IAgentRuntime, 
  Plugin, 
  Action, 
  Provider, 
  Evaluator, 
  Memory, 
  State,
  HandlerCallback,
  Character
} from '@elizaos/core';

// Real Test Database Service with Environment Variable Validation
class DatabaseService extends Service {
  static serviceName = 'database-service';
  static serviceType = 'data_storage' as any;
  capabilityDescription = 'Database service with environment variable requirements';
  
  private connections: Map<string, any> = new Map();
  private isStarted = false;
  private dbUrl: string;
  private apiKey: string;

  static async start(runtime: IAgentRuntime): Promise<DatabaseService> {
    // Require environment variables
    const dbUrl = runtime.getSetting('DATABASE_URL');
    const apiKey = runtime.getSetting('DATABASE_API_KEY');
    
    if (!dbUrl) {
      throw new Error('DATABASE_URL environment variable is required for DatabaseService');
    }
    
    if (!apiKey) {
      throw new Error('DATABASE_API_KEY environment variable is required for DatabaseService');
    }
    
    const service = new DatabaseService(runtime);
    service.dbUrl = dbUrl;
    service.apiKey = apiKey;
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    // Simulate real database connection
    console.log('DatabaseService: Connecting to database...', this.dbUrl);
    
    // Create connection pools
    this.connections.set('read', { 
      host: this.dbUrl,
      status: 'connected',
      queries: 0 
    });
    this.connections.set('write', { 
      host: this.dbUrl,
      status: 'connected', 
      queries: 0 
    });
    
    this.isStarted = true;
    console.log('DatabaseService: Successfully connected with', this.connections.size, 'connection pools');
  }

  async query(sql: string, params: any[] = []): Promise<any[]> {
    if (!this.isStarted) {
      throw new Error('DatabaseService not started');
    }
    
    const connection = this.connections.get('read');
    if (!connection) {
      throw new Error('No read connection available');
    }
    
    connection.queries++;
    console.log(`DatabaseService: Executing query: ${sql.substring(0, 50)}...`);
    
    // Simulate database response
    return [{ id: 1, result: 'mock data', timestamp: new Date().toISOString() }];
  }

  async execute(sql: string, params: any[] = []): Promise<{ affectedRows: number }> {
    if (!this.isStarted) {
      throw new Error('DatabaseService not started');
    }
    
    const connection = this.connections.get('write');
    if (!connection) {
      throw new Error('No write connection available');
    }
    
    connection.queries++;
    console.log(`DatabaseService: Executing command: ${sql.substring(0, 50)}...`);
    
    return { affectedRows: 1 };
  }

  getConnectionStats(): any {
    return {
      isStarted: this.isStarted,
      connections: Array.from(this.connections.entries()).map(([name, conn]) => ({
        name,
        status: conn.status,
        queries: conn.queries
      }))
    };
  }

  async stop(): Promise<void> {
    console.log('DatabaseService: Stopping service...');
    this.connections.clear();
    this.isStarted = false;
    console.log('DatabaseService: Service stopped');
  }
}

// Real Authentication Service (No Environment Variables Required)
class AuthService extends Service {
  static serviceName = 'auth-service';
  static serviceType = 'security' as any;
  capabilityDescription = 'Authentication and authorization service';
  
  private sessions: Map<string, any> = new Map();
  private users: Map<string, any> = new Map();
  private isStarted = false;

  static async start(runtime: IAgentRuntime): Promise<AuthService> {
    const service = new AuthService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    console.log('AuthService: Initializing authentication service...');
    
    // Create default admin user
    this.users.set('admin', {
      id: 'admin',
      username: 'admin',
      roles: ['admin', 'user'],
      createdAt: new Date().toISOString()
    });
    
    this.isStarted = true;
    console.log('AuthService: Authentication service initialized with', this.users.size, 'users');
  }

  async authenticate(username: string, password: string): Promise<{ token: string; user: any } | null> {
    if (!this.isStarted) {
      throw new Error('AuthService not started');
    }
    
    const user = this.users.get(username);
    if (!user) {
      console.log('AuthService: Authentication failed - user not found:', username);
      return null;
    }
    
    // Simulate password check (always succeeds for demo)
    const token = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.sessions.set(token, { userId: user.id, createdAt: new Date() });
    
    console.log('AuthService: User authenticated successfully:', username);
    return { token, user };
  }

  async validateToken(token: string): Promise<any | null> {
    if (!this.isStarted) {
      throw new Error('AuthService not started');
    }
    
    const session = this.sessions.get(token);
    if (!session) {
      return null;
    }
    
    const user = this.users.get(session.userId);
    return user || null;
  }

  getStats(): any {
    return {
      isStarted: this.isStarted,
      activeUsers: this.users.size,
      activeSessions: this.sessions.size
    };
  }

  async stop(): Promise<void> {
    console.log('AuthService: Stopping authentication service...');
    this.sessions.clear();
    this.users.clear();
    this.isStarted = false;
    console.log('AuthService: Authentication service stopped');
  }
}

// Real Action with Service Dependencies
const queryDatabaseAction: Action = {
  name: 'QUERY_DATABASE',
  similes: ['query_db', 'database_query', 'search_db'],
  description: 'Execute database queries using the database service',
  examples: [
    [
      { name: 'user', content: { text: 'query the database for user data' } },
      { 
        name: 'assistant', 
        content: { 
          text: 'I\'ll query the database for user data.',
          actions: ['QUERY_DATABASE']
        } 
      }
    ]
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const dbService = runtime.getService('database-service') as DatabaseService;
    const authService = runtime.getService('auth-service') as AuthService;
    
    if (!dbService) {
      console.log('QUERY_DATABASE validation failed: DatabaseService not available');
      return false;
    }
    
    if (!authService) {
      console.log('QUERY_DATABASE validation failed: AuthService not available');
      return false;
    }
    
    const dbStats = dbService.getConnectionStats();
    if (!dbStats.isStarted) {
      console.log('QUERY_DATABASE validation failed: DatabaseService not started');
      return false;
    }
    
    console.log('QUERY_DATABASE validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    try {
      const dbService = runtime.getService('database-service') as DatabaseService;
      const authService = runtime.getService('auth-service') as AuthService;
      
      if (!dbService || !authService) {
        throw new Error('Required services not available');
      }
      
      // Simulate authentication
      const authResult = await authService.authenticate('admin', 'password');
      if (!authResult) {
        throw new Error('Authentication failed');
      }
      
      // Execute database query
      const results = await dbService.query('SELECT * FROM users WHERE active = ?', [true]);
      
      const response = `Database query executed successfully. Found ${results.length} results. Authentication token: ${authResult.token.substring(0, 20)}...`;
      
      if (callback) {
        await callback({
          text: response,
          actions: ['QUERY_DATABASE'],
          thought: 'Successfully executed database query with authentication'
        });
      }
      
      return {
        text: response,
        data: { 
          queryResults: results,
          authToken: authResult.token,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      const errorMessage = `Database query failed: ${error.message}`;
      console.error('QUERY_DATABASE error:', error);
      
      if (callback) {
        await callback({
          text: errorMessage,
          actions: ['QUERY_DATABASE'],
          thought: 'Database query failed due to error'
        });
      }
      
      throw error;
    }
  }
};

// Real Provider with Service Dependencies  
const systemStatsProvider: Provider = {
  name: 'SYSTEM_STATS',
  description: 'Provides real-time system statistics from services',
  
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    try {
      const dbService = runtime.getService('database-service') as DatabaseService;
      const authService = runtime.getService('auth-service') as AuthService;
      
      const stats: any = {
        timestamp: new Date().toISOString(),
        services: {
          database: dbService ? dbService.getConnectionStats() : { status: 'not_available' },
          auth: authService ? authService.getStats() : { status: 'not_available' }
        }
      };
      
      const text = `[SYSTEM STATS]
Database Service: ${stats.services.database.isStarted ? 'RUNNING' : 'STOPPED'}
${stats.services.database.connections ? `Active Connections: ${stats.services.database.connections.length}` : ''}
Auth Service: ${stats.services.auth.isStarted ? 'RUNNING' : 'STOPPED'}
${stats.services.auth.activeUsers ? `Active Users: ${stats.services.auth.activeUsers}` : ''}
Timestamp: ${stats.timestamp}
[/SYSTEM STATS]`;
      
      return {
        text,
        values: {
          systemStats: stats,
          servicesRunning: (dbService?.getConnectionStats().isStarted || false) && (authService?.getStats().isStarted || false)
        },
        data: {
          fullStats: stats
        }
      };
    } catch (error) {
      console.error('SYSTEM_STATS provider error:', error);
      return {
        text: `[SYSTEM STATS ERROR: ${error.message}]`,
        values: { systemStats: null, servicesRunning: false }
      };
    }
  }
};

// Real Evaluator with Service Dependencies
const performanceEvaluator: Evaluator = {
  name: 'PERFORMANCE_EVALUATOR',
  description: 'Evaluates service performance and logs metrics',
  examples: [
    {
      prompt: 'System performance evaluation',
      messages: [
        { name: 'user', content: { text: 'How is the system performing?' } },
        { name: 'assistant', content: { text: 'Let me check the system performance.' } }
      ],
      outcome: 'Performance metrics logged and evaluated'
    }
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Run evaluation periodically, not on every message
    const shouldRun = Math.random() < 0.3; // 30% chance
    console.log('PERFORMANCE_EVALUATOR validate:', shouldRun ? 'will run' : 'skipping');
    return shouldRun;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    try {
      const dbService = runtime.getService('database-service') as DatabaseService;
      const authService = runtime.getService('auth-service') as AuthService;
      
      const metrics = {
        timestamp: new Date().toISOString(),
        messageId: message.id,
        roomId: message.roomId,
        services: {
          database: dbService ? dbService.getConnectionStats() : null,
          auth: authService ? authService.getStats() : null
        },
        performance: {
          responseTime: Date.now() - (message.createdAt || Date.now()),
          memoryUsage: process.memoryUsage ? process.memoryUsage() : null
        }
      };
      
      // Log performance metrics
      console.log('PERFORMANCE_EVALUATOR metrics:', JSON.stringify(metrics, null, 2));
      
      // Store metrics in memory for future analysis
      if (runtime.createMemory) {
        await runtime.createMemory(
          {
            entityId: runtime.agentId,
            roomId: message.roomId,
            content: {
              text: `Performance evaluation: ${metrics.services.database?.isStarted ? 'DB OK' : 'DB DOWN'}, ${metrics.services.auth?.isStarted ? 'AUTH OK' : 'AUTH DOWN'}`,
              metadata: {
                type: 'performance_metrics',
                ...metrics
              }
            }
          },
          'performance_logs'
        );
      }
      
      return {
        success: true,
        metrics
      };
    } catch (error) {
      console.error('PERFORMANCE_EVALUATOR error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
};

// Plugin with Environment Variable Requirements
const pluginWithEnvVars: Plugin = {
  name: 'plugin-with-env-vars',
  description: 'Plugin that requires specific environment variables',
  services: [DatabaseService],
  actions: [queryDatabaseAction],
  providers: [systemStatsProvider],
  evaluators: [performanceEvaluator],
  
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    console.log('plugin-with-env-vars: Initializing with config:', Object.keys(config));
    
    // Validate required environment variables
    const required = ['DATABASE_URL', 'DATABASE_API_KEY'];
    const missing = required.filter(key => !runtime.getSetting(key));
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    
    console.log('plugin-with-env-vars: All required environment variables present');
  }
};

// Plugin without Environment Variable Requirements
const pluginNoEnvVars: Plugin = {
  name: 'plugin-no-env-vars',
  description: 'Plugin that works without special environment variables',
  services: [AuthService],
  actions: [],
  providers: [],
  evaluators: [],
  
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    console.log('plugin-no-env-vars: Initializing (no env vars required)');
    console.log('plugin-no-env-vars: AuthService will be available for other plugins');
  }
};

// Test Character with Plugin Configuration
const testCharacter: Character = {
  name: 'ConfigTestAgent',
  bio: ['I am a test agent for plugin configuration system testing'],
  system: 'You are a test agent designed to validate plugin configuration functionality.',
  messageExamples: [
    [
      { name: 'user', content: { text: 'test the database' } },
      { name: 'ConfigTestAgent', content: { text: 'I\'ll test the database connection for you.', actions: ['QUERY_DATABASE'] } }
    ]
  ],
  postExamples: [],
  topics: ['testing', 'configuration', 'plugins'],
  adjectives: ['helpful', 'thorough', 'reliable'],
  knowledge: [],
  plugins: ['plugin-with-env-vars', 'plugin-no-env-vars'],
  settings: {
    'DATABASE_URL': 'postgresql://test:test@localhost:5432/testdb',
    'DATABASE_API_KEY': 'test-api-key-12345',
  },
  secrets: {},
  pluginConfig: {
    'plugin-with-env-vars': {
      enabled: true,
      services: {
        'database-service': { enabled: true, settings: {} }
      },
      actions: {
        'QUERY_DATABASE': { enabled: true, settings: {} }
      },
      providers: {
        'SYSTEM_STATS': { enabled: true, settings: {} }
      },
      evaluators: {
        'PERFORMANCE_EVALUATOR': { enabled: true, settings: {} }
      }
    },
    'plugin-no-env-vars': {
      enabled: true,
      services: {
        'auth-service': { enabled: true, settings: {} }
      }
    }
  }
};

// Scenario Test Function
export async function testPluginConfigurationSystem(runtime: IAgentRuntime): Promise<void> {
  console.log('🧪 Starting Plugin Configuration System Integration Test');
  
  // Register test plugins
  await runtime.registerPlugin(pluginWithEnvVars);
  await runtime.registerPlugin(pluginNoEnvVars);
  
  console.log('✅ Plugins registered successfully');
  
  // Test 1: Verify Services Started
  console.log('🔍 Test 1: Verify services started correctly');
  const dbService = runtime.getService('database-service') as DatabaseService;
  const authService = runtime.getService('auth-service') as AuthService;
  
  if (!dbService) throw new Error('DatabaseService not found');
  if (!authService) throw new Error('AuthService not found');
  
  const dbStats = dbService.getConnectionStats();
  const authStats = authService.getStats();
  
  if (!dbStats.isStarted) throw new Error('DatabaseService not started');
  if (!authStats.isStarted) throw new Error('AuthService not started');
  
  console.log('✅ Test 1 passed: Services started correctly');
  
  // Test 2: Test Action Execution with Service Dependencies
  console.log('🔍 Test 2: Test action execution with service dependencies');
  
  const queryAction = runtime.actions.find(a => a.name === 'QUERY_DATABASE');
  if (!queryAction) throw new Error('QUERY_DATABASE action not found');
  
  const testMessage = {
    id: 'test-msg-1',
    entityId: 'test-user',
    roomId: 'test-room',
    agentId: runtime.agentId,
    content: { text: 'query the database for user data' },
    createdAt: Date.now()
  };
  
  const isValid = await queryAction.validate(runtime, testMessage);
  if (!isValid) throw new Error('Action validation failed');
  
  const result = await queryAction.handler(runtime, testMessage);
  if (!result || !result.text) throw new Error('Action execution failed');
  
  console.log('✅ Test 2 passed: Action executed successfully with service dependencies');
  
  // Test 3: Test Provider with Service Dependencies
  console.log('🔍 Test 3: Test provider with service dependencies');
  
  const statsProvider = runtime.providers.find(p => p.name === 'SYSTEM_STATS');
  if (!statsProvider) throw new Error('SYSTEM_STATS provider not found');
  
  const providerResult = await statsProvider.get(runtime, testMessage);
  if (!providerResult || !providerResult.text) throw new Error('Provider execution failed');
  if (!providerResult.values?.systemStats) throw new Error('Provider did not return system stats');
  
  console.log('✅ Test 3 passed: Provider executed successfully with service dependencies');
  
  // Test 4: Test Service Hot-Swap (Disable/Enable)
  console.log('🔍 Test 4: Test service hot-swap functionality');
  
  // Disable database service
  await runtime.configurePlugin('plugin-with-env-vars', {
    services: {
      'database-service': { enabled: false }
    }
  });
  
  // Verify service was stopped
  const dbServiceAfterDisable = runtime.getService('database-service');
  if (dbServiceAfterDisable) throw new Error('DatabaseService should be disabled but is still running');
  
  // Verify dependent action now fails validation
  const validationAfterDisable = await queryAction.validate(runtime, testMessage);
  if (validationAfterDisable) throw new Error('Action should fail validation when service is disabled');
  
  // Re-enable database service
  await runtime.configurePlugin('plugin-with-env-vars', {
    services: {
      'database-service': { enabled: true }
    }
  });
  
  // Verify service was restarted
  const dbServiceAfterEnable = runtime.getService('database-service') as DatabaseService;
  if (!dbServiceAfterEnable) throw new Error('DatabaseService should be enabled but is not running');
  
  const dbStatsAfterEnable = dbServiceAfterEnable.getConnectionStats();
  if (!dbStatsAfterEnable.isStarted) throw new Error('DatabaseService should be started after re-enabling');
  
  // Verify dependent action now passes validation
  const validationAfterEnable = await queryAction.validate(runtime, testMessage);
  if (!validationAfterEnable) throw new Error('Action should pass validation when service is re-enabled');
  
  console.log('✅ Test 4 passed: Service hot-swap functionality works correctly');
  
  // Test 5: Test Component Registration/Deregistration
  console.log('🔍 Test 5: Test component registration/deregistration');
  
  // Check initial state
  const initialActions = runtime.actions.map(a => a.name);
  const initialProviders = runtime.providers.map(p => p.name);
  const initialEvaluators = runtime.evaluators.map(e => e.name);
  
  if (!initialActions.includes('QUERY_DATABASE')) throw new Error('QUERY_DATABASE action not initially registered');
  if (!initialProviders.includes('SYSTEM_STATS')) throw new Error('SYSTEM_STATS provider not initially registered');
  if (!initialEvaluators.includes('PERFORMANCE_EVALUATOR')) throw new Error('PERFORMANCE_EVALUATOR evaluator not initially registered');
  
  // Disable action
  await runtime.disableComponent('plugin-with-env-vars', 'QUERY_DATABASE', 'action');
  
  const actionsAfterDisable = runtime.actions.map(a => a.name);
  if (actionsAfterDisable.includes('QUERY_DATABASE')) throw new Error('QUERY_DATABASE action should be unregistered');
  
  // Re-enable action
  await runtime.enableComponent('plugin-with-env-vars', 'QUERY_DATABASE', 'action', queryAction);
  
  const actionsAfterEnable = runtime.actions.map(a => a.name);
  if (!actionsAfterEnable.includes('QUERY_DATABASE')) throw new Error('QUERY_DATABASE action should be re-registered');
  
  console.log('✅ Test 5 passed: Component registration/deregistration works correctly');
  
  // Test 6: Test Environment Variable Validation
  console.log('🔍 Test 6: Test environment variable validation');
  
  // Create a plugin that should fail due to missing env vars
  const pluginWithMissingEnvVars: Plugin = {
    name: 'plugin-missing-env-vars',
    description: 'Plugin that requires missing environment variables',
    services: [],
    
    init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
      const missingVar = runtime.getSetting('MISSING_ENV_VAR');
      if (!missingVar) {
        throw new Error('MISSING_ENV_VAR environment variable is required');
      }
    }
  };
  
  // This should fail
  try {
    await runtime.registerPlugin(pluginWithMissingEnvVars);
    throw new Error('Plugin registration should have failed due to missing environment variable');
  } catch (error) {
    if (!error.message.includes('MISSING_ENV_VAR')) {
      throw new Error(`Unexpected error message: ${error.message}`);
    }
    console.log('✅ Test 6 passed: Environment variable validation works correctly');
  }
  
  console.log('🎉 All Plugin Configuration System Integration Tests Passed!');
  
  // Final Stats Report
  const finalDbStats = dbServiceAfterEnable.getConnectionStats();
  const finalAuthStats = authService.getStats();
  
  console.log('📊 Final System Stats:');
  console.log('- Database Service:', finalDbStats);
  console.log('- Auth Service:', finalAuthStats);
  console.log('- Actions:', runtime.actions.length);
  console.log('- Providers:', runtime.providers.length);
  console.log('- Evaluators:', runtime.evaluators.length);
  console.log('- Services:', runtime.services.size);
}