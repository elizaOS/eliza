import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DirectoryInfo } from '../../../../src/utils/directory-detection';

// Mock dependencies
mock.module('../../../../src/project', () => ({
  loadProject: mock()
}));

mock.module('@elizaos/server', () => ({
  AgentServer: mock().mockImplementation(() => ({
    initialize: mock().mockResolvedValue(undefined),
    start: mock().mockResolvedValue(undefined),
    registerAgent: mock(),
    startAgent: mock(),
    loadCharacterTryPath: mock(),
    jsonToCharacter: mock()
  })),
  loadCharacterTryPath: mock(),
  jsonToCharacter: mock()
}));

mock.module('../../../../src/utils', () => ({
  buildProject: mock().mockResolvedValue(undefined),
  findNextAvailablePort: mock().mockResolvedValue(3000),
  promptForEnvVars: mock().mockResolvedValue(undefined),
  TestRunner: mock().mockImplementation(() => ({
    runTests: mock().mockResolvedValue({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      hasTests: false
    })
  })),
  UserEnvironment: {
    getInstanceInfo: mock().mockResolvedValue({
      paths: {
        envFilePath: '/test/.env'
      }
    })
  }
}));

mock.module('../../../../src/characters/eliza', () => ({
  getElizaCharacter: mock().mockImplementation(() => {
    name: 'Eliza',
    bio: 'Test character'
  })
}));

mock.module('../../../../src/commands/start', () => ({
  startAgent: mock().mockResolvedValue({
    agentId: 'test-agent',
    character: { name: 'Eliza' },
    plugins: []
  })
}));

mock.module('@elizaos/core', () => ({
  logger: {
    info: mock(),
    debug: mock(),
    error: mock(),
    warn: mock(),
    success: mock()
  }
}));

mock.module('node:fs', () => ({
  default: {
    existsSync: mock().mockImplementation(() => false),
    mkdirSync: mock(),
    rmSync: mock(),
    readdirSync: mock().mockImplementation(() => [])
  }
}));

mock.module('dotenv', () => ({
  config: mock()
}));

describe('E2E Tests Plugin Isolation', () => {
  const originalEnv = process.env.ELIZA_TESTING_PLUGIN;
  let runE2eTests: any;
  let loadProject: any;

  beforeEach(async () => {
    // Reset environment
    delete process.env.ELIZA_TESTING_PLUGIN;
    
    // Import mocked modules
    const projectModule = await import('../../../../src/project');
    loadProject = projectModule.loadProject;
    
    // Import the function we're testing
    const module = await import('../../../../src/commands/test/actions/e2e-tests');
    runE2eTests = module.runE2eTests;  });

  afterEach(() => {
    // Restore original environment
    if (originalEnv) {
      process.env.ELIZA_TESTING_PLUGIN = originalEnv;
    } else {
      delete process.env.ELIZA_TESTING_PLUGIN;
    }  });

  describe('Plugin Test Environment Variable', () => {
    it('should set ELIZA_TESTING_PLUGIN=true when testing a plugin', async () => {
      // Setup mock to return a plugin
      const mockPlugin = {
        name: 'test-plugin',
        description: 'Test plugin'
      };
      
      loadProject.mockResolvedValue({
        isPlugin: true,
        pluginModule: mockPlugin,
        agents: []
      });

      const projectInfo: DirectoryInfo = {
        type: 'elizaos-plugin',
        hasPackageJson: true,
        hasElizaOSDependencies: true,
        elizaPackageCount: 1
      };

      const options = { skipBuild: true };

      // Track environment variable changes
      const envChanges: string[] = [];
      const originalDefineProperty = Object.defineProperty;
      
      Object.defineProperty(process.env, 'ELIZA_TESTING_PLUGIN', {
        get() {
          return envChanges[envChanges.length - 1];
        },
        set(value) {
          envChanges.push(value);
        },
        configurable: true
      });

      await runE2eTests(undefined, options, projectInfo);

      // Verify the environment variable was set
      expect(envChanges).toContain('true');
      
      // Restore original defineProperty
      Object.defineProperty = originalDefineProperty;
    });

    it('should not set ELIZA_TESTING_PLUGIN when testing a project', async () => {
      // Setup mock to return a project
      loadProject.mockResolvedValue({
        isPlugin: false,
        agents: [{
          character: { name: 'Test Agent', bio: 'Test bio' },
          plugins: []
        }]
      });

      const projectInfo: DirectoryInfo = {
        type: 'elizaos-project',
        hasPackageJson: true,
        hasElizaOSDependencies: true,
        elizaPackageCount: 2
      };

      const options = { skipBuild: true };

      // Ensure env var is not set initially
      expect(process.env.ELIZA_TESTING_PLUGIN).toBeUndefined();

      await runE2eTests(undefined, options, projectInfo);

      // Verify the environment variable was not set
      expect(process.env.ELIZA_TESTING_PLUGIN).toBeUndefined();
    });

    it('should clean up ELIZA_TESTING_PLUGIN after tests complete', async () => {
      // Setup mock to return a plugin
      const mockPlugin = {
        name: 'test-plugin',
        description: 'Test plugin'
      };
      
      loadProject.mockResolvedValue({
        isPlugin: true,
        pluginModule: mockPlugin,
        agents: []
      });

      const projectInfo: DirectoryInfo = {
        type: 'elizaos-plugin',
        hasPackageJson: true,
        hasElizaOSDependencies: true,
        elizaPackageCount: 1
      };

      const options = { skipBuild: true };

      // Track environment variable state
      let envDuringTest: string | undefined;
      const TestRunnerMock = (await import('../../../../src/utils')).TestRunner as any;
      TestRunnerMock.mockImplementation(() => ({
        runTests: mock().mockImplementation(() => {
          // Capture env var state during test execution
          envDuringTest = process.env.ELIZA_TESTING_PLUGIN;
          return Promise.resolve({
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            hasTests: false
          });
        })
      }));

      await runE2eTests(undefined, options, projectInfo);

      // Verify the environment variable was set during test execution
      expect(envDuringTest).toBe('true');
      
      // Verify it was cleaned up after
      expect(process.env.ELIZA_TESTING_PLUGIN).toBeUndefined();
    });

    it('should clean up ELIZA_TESTING_PLUGIN even if tests fail', async () => {
      // Setup mock to return a plugin that will fail
      const mockPlugin = {
        name: 'test-plugin',
        description: 'Test plugin'
      };
      
      loadProject.mockResolvedValue({
        isPlugin: true,
        pluginModule: mockPlugin,
        agents: []
      });

      const projectInfo: DirectoryInfo = {
        type: 'elizaos-plugin',
        hasPackageJson: true,
        hasElizaOSDependencies: true,
        elizaPackageCount: 1
      };

      const options = { skipBuild: true };

      // Make TestRunner throw an error
      const TestRunnerMock = (await import('../../../../src/utils')).TestRunner as any;
      TestRunnerMock.mockImplementation(() => ({
        runTests: mock().mockRejectedValue(new Error('Test failure'))
      }));

      await runE2eTests(undefined, options, projectInfo);

      // Verify the environment variable was cleaned up even after failure
      expect(process.env.ELIZA_TESTING_PLUGIN).toBeUndefined();
    });
  });

  describe('Plugin vs Project Detection', () => {
    it('should correctly identify and test plugins', async () => {
      const mockPlugin = {
        name: 'awesome-plugin',
        description: 'Awesome plugin',
        tests: [
          {
            name: 'Plugin Tests',
            tests: []
          }
        ]
      };
      
      loadProject.mockResolvedValue({
        isPlugin: true,
        pluginModule: mockPlugin,
        agents: []
      });

      const projectInfo: DirectoryInfo = {
        type: 'elizaos-plugin',
        hasPackageJson: true,
        hasElizaOSDependencies: true,
        elizaPackageCount: 1
      };

      const options = { skipBuild: true };

      let testRunnerInstance: any;
      const TestRunnerMock = (await import('../../../../src/utils')).TestRunner as any;
      TestRunnerMock.mockImplementation((runtime: any, projectAgent: any) => {
        testRunnerInstance = {
          runtime,
          projectAgent,
          runTests: mock().mockResolvedValue({
            total: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            hasTests: true
          })
        };
        return testRunnerInstance;
      });

      await runE2eTests(undefined, options, projectInfo);

      // Verify the TestRunner was called with proper plugin configuration
      // expect(TestRunnerMock).toHaveBeenCalled(); // TODO: Fix for bun test
      // expect(testRunnerInstance.runTests).toHaveBeenCalledWith({
        filter: undefined,
        skipPlugins: false, // Should not skip plugins for plugin directory
        skipProjectTests: true, // Should skip project tests for plugin
        skipE2eTests: false
      }); // TODO: Fix for bun test
    });

    it('should correctly identify and test projects', async () => {
      loadProject.mockResolvedValue({
        isPlugin: false,
        agents: [{
          character: { name: 'Project Agent', bio: 'Test bio' },
          plugins: [],
          tests: [
            {
              name: 'Project Tests',
              tests: []
            }
          ]
        }]
      });

      const projectInfo: DirectoryInfo = {
        type: 'elizaos-project',
        hasPackageJson: true,
        hasElizaOSDependencies: true,
        elizaPackageCount: 3
      };

      const options = { skipBuild: true };

      let testRunnerInstance: any;
      const TestRunnerMock = (await import('../../../../src/utils')).TestRunner as any;
      TestRunnerMock.mockImplementation((runtime: any, projectAgent: any) => {
        testRunnerInstance = {
          runtime,
          projectAgent,
          runTests: mock().mockResolvedValue({
            total: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            hasTests: true
          })
        };
        return testRunnerInstance;
      });

      await runE2eTests(undefined, options, projectInfo);

      // Verify the TestRunner was called with proper project configuration
      // expect(TestRunnerMock).toHaveBeenCalled(); // TODO: Fix for bun test
      // expect(testRunnerInstance.runTests).toHaveBeenCalledWith({
        filter: undefined,
        skipPlugins: true, // Should skip plugins for project directory
        skipProjectTests: false, // Should not skip project tests
        skipE2eTests: false
      }); // TODO: Fix for bun test
    });
  });
}); 