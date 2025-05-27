import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
// import { resolveImport } from '@/utils/resolve-import'; // Using alias defined in vitest.config.ts
import { resolveImport } from '../../src/utils/resolve-import';

// Mock tsconfig-paths
vi.mock('tsconfig-paths', () => ({
  // We only mock createMatchPath, as it's the only function used by resolveImport.ts
  createMatchPath: vi.fn(),
}));

// Import the System Under Test (SUT) and the mocked dependency AFTER vi.mock
import { createMatchPath } from 'tsconfig-paths'; // This will be the vi.fn() from the mock

describe('resolveImport', () => {
  const baseMockConfig = {
    absoluteBaseUrl: '/project/src',
    paths: {
      '@/*': ['./*'],
      'lib/*': ['./lib/*'],
    },
  };

  beforeEach(() => {
    // Clear mock history and reset implementations before each test
    vi.clearAllMocks(); // Clears out mock implementations, return values, etc.
    // vi.resetAllMocks(); // Resets call counts, instances, and results, but keeps existing mock implementations
    // Using clearAllMocks is often safer for full isolation if mocks are configured per test.
  });

  // Test 1: Diagnostic for mock setup
  it('diagnostic: createMatchPath mock should return a function that can be called', () => {
    const mockMatcherFn = vi.fn().mockReturnValue('resolved_path_example');
    (createMatchPath as Mock).mockReturnValue(mockMatcherFn);

    const returnedFn = (createMatchPath as Mock)('base', {});
    expect(typeof returnedFn).toBe('function');
    expect(returnedFn).toBe(mockMatcherFn);

    const finalResult = returnedFn('import', undefined, () => true, ['.ts']);
    expect(finalResult).toBe('resolved_path_example');
    expect(mockMatcherFn).toHaveBeenCalledWith('import', undefined, expect.any(Function), ['.ts']);
  });

  // Test 2: Core successful resolution
  it('should resolve a path by calling createMatchPath and its returned matcher', async () => {
    const importPath = '@/components/Button';
    const expectedResolvedPath = '/project/src/components/Button.ts';
    const mockConfig = { ...baseMockConfig };

    const mockMatcher = vi.fn().mockReturnValue(expectedResolvedPath);
    (createMatchPath as Mock).mockReturnValue(mockMatcher);

    const result = await resolveImport(importPath, mockConfig);

    expect(createMatchPath).toHaveBeenCalledWith(mockConfig.absoluteBaseUrl, mockConfig.paths);
    expect(mockMatcher).toHaveBeenCalledWith(importPath, undefined, expect.any(Function), ['.ts']);
    expect(result).toBe(expectedResolvedPath);
  });

  // Test 3: Path not found (matcher returns null)
  it('should return null if the matcher returns null (path not found)', async () => {
    const importPath = 'nonexistent/module';
    const mockConfig = { ...baseMockConfig };

    const mockMatcher = vi.fn().mockReturnValue(null);
    (createMatchPath as Mock).mockReturnValue(mockMatcher);

    const result = await resolveImport(importPath, mockConfig);

    expect(createMatchPath).toHaveBeenCalledWith(mockConfig.absoluteBaseUrl, mockConfig.paths);
    expect(mockMatcher).toHaveBeenCalledWith(importPath, undefined, expect.any(Function), ['.ts']);
    expect(result).toBeNull();
  });

  // Test 4: Correctly passes extensions
  it('should correctly pass extensions to the matcher', async () => {
    const importPath = '@/services/api';
    const mockConfig = { ...baseMockConfig };
    const expectedResolvedPath = '/project/src/services/api.ts'; // Dummy value for this test

    const mockMatcher = vi.fn().mockReturnValue(expectedResolvedPath);
    (createMatchPath as Mock).mockReturnValue(mockMatcher);

    await resolveImport(importPath, mockConfig);

    expect(mockMatcher).toHaveBeenCalledWith(expect.anything(), undefined, expect.any(Function), [
      '.ts',
    ]);
  });

  // Test 5: Works with empty paths in config
  it('should work with empty paths in config, calling matcher correctly', async () => {
    const configWithEmptyPaths = {
      absoluteBaseUrl: '/project/src',
      paths: {},
    };
    const importPath = 'some/module';
    const expectedResolvedPath = '/project/src/some/module.ts'; // Dummy value for this test

    const mockMatcher = vi.fn().mockReturnValue(expectedResolvedPath);
    (createMatchPath as Mock).mockReturnValue(mockMatcher);

    const result = await resolveImport(importPath, configWithEmptyPaths);

    expect(createMatchPath).toHaveBeenCalledWith(
      configWithEmptyPaths.absoluteBaseUrl,
      configWithEmptyPaths.paths
    );
    expect(mockMatcher).toHaveBeenCalledWith(importPath, undefined, expect.any(Function), ['.ts']);
    expect(result).toBe(expectedResolvedPath);
  });
});
