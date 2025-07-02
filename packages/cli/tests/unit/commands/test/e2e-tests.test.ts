import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DirectoryInfo } from '../../../../src/utils/directory-detection';

// Mock dependencies
mock.module('../../../../src/project', () => ({
  loadProject: mock(),
}));

mock.module('@elizaos/server', () => ({
  AgentServer: mock().mockImplementation(() => ({
    initialize: mock().mockResolvedValue(undefined),
    start: mock().mockResolvedValue(undefined),
    registerAgent: mock(),
    startAgent: mock(),
    loadCharacterTryPath: mock(),
    jsonToCharacter: mock(),
  })),
  loadCharacterTryPath: mock(),
  jsonToCharacter: mock(),
}));

// Create explicit mocks for UserEnvironment
const mockFindMonorepoRoot = mock().mockReturnValue('/test/monorepo');
const mockGetInstance = mock().mockReturnValue({
  findMonorepoRoot: mockFindMonorepoRoot,
});
const mockGetInstanceInfo = mock().mockResolvedValue({
  paths: {
    envFilePath: '/test/.env',
  },
});

mock.module('../../../../src/utils', () => ({
  buildProject: mock().mockResolvedValue(undefined),
  findNextAvailablePort: mock().mockResolvedValue(3001),
  TestRunner: mock(() => ({
    runTests: mock().mockResolvedValue({ failed: false, hasTests: true }),
  })),
  UserEnvironment: {
    getInstanceInfo: mockGetInstanceInfo,
    getInstance: mockGetInstance,
  },
}));

mock.module('../../../../src/characters/eliza', () => ({
  getElizaCharacter: mock().mockImplementation(() => ({
    name: 'Eliza',
    bio: 'Test character',
  })),
}));

mock.module('../../../../src/commands/start', () => ({
  startAgent: mock().mockResolvedValue({
    agentId: 'test-agent',
    character: { name: 'Eliza' },
    plugins: [],
  }),
}));

mock.module('@elizaos/core', () => ({
  logger: {
    info: mock(),
    debug: mock(),
    error: mock(),
    warn: mock(),
    success: mock(),
  },
}));

mock.module('node:fs', () => ({
  existsSync: mock(() => false),
  mkdirSync: mock(),
  rmSync: mock(),
  readdirSync: mock(() => []),
  createWriteStream: mock(),
  createReadStream: mock(),
  readFileSync: mock(() => '{}'),
  writeFileSync: mock(),
  statSync: mock(() => ({ isDirectory: () => true })),
}));

mock.module('dotenv', () => ({
  default: {
    config: mock(),
  },
  config: mock(),
}));

// Test fixtures for consistent data
const TestFixtures = {
  mockPlugin: {
    name: 'test-plugin',
    description: 'Test plugin',
  },

  mockProject: {
    isPlugin: false,
    agents: [
      {
        character: { name: 'Test Agent', bio: 'Test bio' },
        plugins: [],
      },
    ],
  },

  mockPluginProject: {
    isPlugin: true,
    pluginModule: {
      name: 'test-plugin',
      description: 'Test plugin',
    },
    agents: [
      {
        character: { name: 'Test Agent', bio: 'Test bio' },
        plugins: [],
      },
    ],
  },

  mockDirectoryInfo: {
    plugin: {
      type: 'elizaos-plugin' as const,
      hasPackageJson: true,
      hasElizaOSDependencies: true,
      elizaPackageCount: 1,
    },
    project: {
      type: 'elizaos-project' as const,
      hasPackageJson: true,
      hasElizaOSDependencies: true,
      elizaPackageCount: 2,
    },
  },

  mockOptions: {
    skipBuild: true,
  },
};

describe('E2E Tests Plugin Isolation', () => {
  let originalElizaTestingPlugin: string | undefined;
  let runE2eTests: any;
  let loadProject: any;
  let startAgentMock: any;
  let TestRunnerMock: any;

  beforeEach(async () => {
    // Save original ELIZA_TESTING_PLUGIN value specifically
    originalElizaTestingPlugin = process.env.ELIZA_TESTING_PLUGIN;

    // Clean environment
    delete process.env.ELIZA_TESTING_PLUGIN;

    // Reset all mocks systematically
    mockFindMonorepoRoot.mockClear();
    mockGetInstance.mockClear();
    mockGetInstanceInfo.mockClear();

    // Reconfigure mocks with known state
    mockFindMonorepoRoot.mockReturnValue('/test/monorepo');
    mockGetInstance.mockReturnValue({
      findMonorepoRoot: mockFindMonorepoRoot,
    });
    mockGetInstanceInfo.mockResolvedValue({
      paths: {
        envFilePath: '/test/.env',
      },
    });

    // Import and setup mocked modules
    const projectModule = await import('../../../../src/project');
    loadProject = projectModule.loadProject;
    loadProject.mockClear();

    const startModule = await import('../../../../src/commands/start');
    startAgentMock = startModule.startAgent;
    startAgentMock.mockClear();

    const utilsModule = await import('../../../../src/utils');
    TestRunnerMock = utilsModule.TestRunner;
    TestRunnerMock.mockClear();

    // Import the function we're testing
    const module = await import('../../../../src/commands/test/actions/e2e-tests');
    runE2eTests = module.runE2eTests;
  });

  afterEach(() => {
    // Restore only the specific environment variable we care about
    if (originalElizaTestingPlugin !== undefined) {
      process.env.ELIZA_TESTING_PLUGIN = originalElizaTestingPlugin;
    } else {
      delete process.env.ELIZA_TESTING_PLUGIN;
    }
  });

  describe('Plugin Test Environment Variable', () => {
    it('should set ELIZA_TESTING_PLUGIN=true when testing a plugin', async () => {
      // Setup mock to return a plugin using test fixtures
      const mockRuntime = {
        character: { name: 'Eliza' },
        plugins: [TestFixtures.mockPlugin],
      };

      loadProject.mockResolvedValue(TestFixtures.mockPluginProject);
      startAgentMock.mockResolvedValue(mockRuntime);

      // Track environment changes with proper cleanup
      let envWasSet = false;
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        process.env,
        'ELIZA_TESTING_PLUGIN'
      );

      // Simple spy on environment variable
      Object.defineProperty(process.env, 'ELIZA_TESTING_PLUGIN', {
        get: () => (envWasSet ? 'true' : undefined),
        set: (value) => {
          envWasSet = value === 'true';
        },
        configurable: true,
        enumerable: true,
      });

      try {
        await runE2eTests(
          undefined,
          TestFixtures.mockOptions,
          TestFixtures.mockDirectoryInfo.plugin
        );

        // Verify the environment variable was set
        expect(envWasSet).toBe(true);
      } finally {
        // Restore original descriptor or delete property
        if (originalDescriptor) {
          Object.defineProperty(process.env, 'ELIZA_TESTING_PLUGIN', originalDescriptor);
        } else {
          delete process.env.ELIZA_TESTING_PLUGIN;
        }
      }
    });

    it('should not set ELIZA_TESTING_PLUGIN when testing a project', async () => {
      // Setup mock to return a project using test fixtures
      loadProject.mockResolvedValue(TestFixtures.mockProject);

      // Ensure env var is not set initially
      expect(process.env.ELIZA_TESTING_PLUGIN).toBeUndefined();

      await runE2eTests(
        undefined,
        TestFixtures.mockOptions,
        TestFixtures.mockDirectoryInfo.project
      );

      // Verify the environment variable was not set
      expect(process.env.ELIZA_TESTING_PLUGIN).toBeUndefined();
    });

    it('should clean up ELIZA_TESTING_PLUGIN after tests complete', async () => {
      // Setup mock to return a plugin using test fixtures
      loadProject.mockResolvedValue(TestFixtures.mockPluginProject);

      // Track environment variable state during test execution
      let envDuringTest: string | undefined;
      TestRunnerMock.mockImplementation(() => ({
        runTests: mock().mockImplementation(() => {
          // Capture env var state during test execution
          envDuringTest = process.env.ELIZA_TESTING_PLUGIN;
          return Promise.resolve({
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            hasTests: false,
          });
        }),
      }));

      await runE2eTests(undefined, TestFixtures.mockOptions, TestFixtures.mockDirectoryInfo.plugin);

      // Verify the environment variable was set during test execution
      expect(envDuringTest).toBe('true');

      // Verify it was cleaned up after
      expect(process.env.ELIZA_TESTING_PLUGIN).toBeUndefined();
    });

    it('should clean up ELIZA_TESTING_PLUGIN even if tests fail', async () => {
      // Setup mock to return a plugin that will fail using test fixtures
      loadProject.mockResolvedValue(TestFixtures.mockPluginProject);

      // Make TestRunner throw an error
      TestRunnerMock.mockImplementation(() => ({
        runTests: mock().mockRejectedValue(new Error('Test failure')),
      }));

      await runE2eTests(undefined, TestFixtures.mockOptions, TestFixtures.mockDirectoryInfo.plugin);

      // Verify the environment variable was cleaned up even after failure
      expect(process.env.ELIZA_TESTING_PLUGIN).toBeUndefined();
    });
  });

  describe('Plugin vs Project Detection', () => {
    it('should correctly identify and test plugins', async () => {
      // Setup plugin with test fixtures
      const pluginWithTests = {
        ...TestFixtures.mockPluginProject,
        pluginModule: {
          ...TestFixtures.mockPlugin,
          name: 'awesome-plugin',
          tests: [
            {
              name: 'Plugin Tests',
              tests: [],
            },
          ],
        },
      };

      loadProject.mockResolvedValue(pluginWithTests);

      let testRunnerInstance: any;
      TestRunnerMock.mockImplementation((runtime: any, projectAgent: any) => {
        testRunnerInstance = {
          runtime,
          projectAgent,
          runTests: mock().mockResolvedValue({
            total: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            hasTests: true,
          }),
        };
        return testRunnerInstance;
      });

      await runE2eTests(undefined, TestFixtures.mockOptions, TestFixtures.mockDirectoryInfo.plugin);

      // Verify the TestRunner was instantiated (basic verification)
      expect(TestRunnerMock).toHaveBeenCalled();
    });

    it('should correctly identify and test projects', async () => {
      // Setup project with test fixtures
      const projectWithTests = {
        ...TestFixtures.mockProject,
        agents: [
          {
            character: { name: 'Project Agent', bio: 'Test bio' },
            plugins: [],
            tests: [
              {
                name: 'Project Tests',
                tests: [],
              },
            ],
          },
        ],
      };

      loadProject.mockResolvedValue(projectWithTests);

      let testRunnerInstance: any;
      TestRunnerMock.mockImplementation((runtime: any, projectAgent: any) => {
        testRunnerInstance = {
          runtime,
          projectAgent,
          runTests: mock().mockResolvedValue({
            total: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            hasTests: true,
          }),
        };
        return testRunnerInstance;
      });

      const projectInfo = {
        ...TestFixtures.mockDirectoryInfo.project,
        elizaPackageCount: 3, // Override for this test
      };

      await runE2eTests(undefined, TestFixtures.mockOptions, projectInfo);

      // Verify the TestRunner was instantiated (basic verification)
      expect(TestRunnerMock).toHaveBeenCalled();
    });
  });
});
