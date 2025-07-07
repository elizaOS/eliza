import { expect, test, describe } from 'bun:test';

// Add TypeScript declarations for Node.js modules and globals
declare function require(id: string): any;
declare const process: { cwd(): string };

describe('App Tests', () => {
  // Test that checks if main.tsx is a valid module
  test('main.tsx file exists and contains expected structure', () => {
    // Import Node.js built-in modules
    const fs = require('fs');
    const path = require('path');

    // Read the main.tsx file content
    const mainPath = path.resolve(process.cwd(), 'src/main.tsx');
    const fileExists = fs.existsSync(mainPath);

    expect(fileExists).toBe(true);

    if (fileExists) {
      const content = fs.readFileSync(mainPath, 'utf8');

      // Check for key React components/elements we expect to find
      expect(content).toContain('import React');
      expect(content).toContain('useState');
      expect(content).toContain('createRoot');
      expect(content).toContain('ElizaWrapper');

      // Verify it contains code to check server availability
      expect(content).toContain('fetch');
    }
  });

  // Test React module can be imported and used
  test('React can be imported and used', () => {
    const React = require('react');
    expect(React).toBeDefined();

    // Test creating a React element
    const element = React.createElement('div', { className: 'test' }, 'Test Content');

    expect(element).toBeDefined();
    expect(element.type).toBe('div');
    expect(element.props.className).toBe('test');
    expect(element.props.children).toBe('Test Content');
  });

  // Test package dependencies
  test('package has correct dependencies', () => {
    const fs = require('fs');
    const path = require('path');

    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    // Check for required dependencies
    expect(packageJson.dependencies).toBeDefined();
    expect(packageJson.dependencies['react']).toBeDefined();
    expect(packageJson.dependencies['react-dom']).toBeDefined();
    expect(packageJson.dependencies['@elizaos/api-client']).toBeDefined();

    // Check for development dependencies
    expect(packageJson.devDependencies).toBeDefined();
    expect(packageJson.devDependencies['@tauri-apps/cli']).toBeDefined();
    expect(packageJson.devDependencies['typescript']).toBeDefined();
  });

  // Test project structure
  test('project has correct file structure', () => {
    const fs = require('fs');
    const path = require('path');

    // Check src directory exists
    const srcPath = path.resolve(process.cwd(), 'src');
    expect(fs.existsSync(srcPath)).toBe(true);

    // Check main files exist
    expect(fs.existsSync(path.resolve(srcPath, 'main.tsx'))).toBe(true);

    // Check Tauri source directory exists
    const srcTauriPath = path.resolve(process.cwd(), 'src-tauri');
    expect(fs.existsSync(srcTauriPath)).toBe(true);

    // Check Tauri config files exist
    expect(fs.existsSync(path.resolve(srcTauriPath, 'Cargo.toml'))).toBe(true);
  });
});
