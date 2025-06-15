import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Environment Setup', () => {
  it('should verify configuration files exist', () => {
    const requiredFiles = [
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'tsup.config.ts',
      'vitest.config.ts',
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(process.cwd(), file);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it('should have proper src directory structure', () => {
    const srcDir = path.join(process.cwd(), 'src');
    expect(fs.existsSync(srcDir)).toBe(true);

    const requiredSrcFiles = ['index.ts', 'plugin.ts'];

    for (const file of requiredSrcFiles) {
      const filePath = path.join(srcDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it('should have a valid package.json with required fields', () => {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    expect(fs.existsSync(packageJsonPath)).toBe(true);

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    expect(packageJson).toHaveProperty('name', '@elizaos/project-starter');
    expect(packageJson).toHaveProperty('version');
    expect(packageJson).toHaveProperty('type', 'module');
    expect(packageJson).toHaveProperty('main');
    expect(packageJson).toHaveProperty('module');
    expect(packageJson).toHaveProperty('types');
    expect(packageJson).toHaveProperty('dependencies');
    expect(packageJson).toHaveProperty('devDependencies');
    expect(packageJson).toHaveProperty('scripts');

    // Check for required dependencies
    expect(packageJson.dependencies).toHaveProperty('@elizaos/core');

    // Check for required scripts
    expect(packageJson.scripts).toHaveProperty('build');
    expect(packageJson.scripts).toHaveProperty('test');
  });

  it('should have a valid tsconfig.json with required configuration', () => {
    const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
    expect(fs.existsSync(tsconfigPath)).toBe(true);

    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    expect(tsconfig).toHaveProperty('compilerOptions');

    // Check compiler options
    expect(tsconfig.compilerOptions).toHaveProperty('target');
    expect(tsconfig.compilerOptions).toHaveProperty('module');
    expect(tsconfig.compilerOptions).toHaveProperty('moduleResolution');
    expect(tsconfig.compilerOptions).toHaveProperty('esModuleInterop');
  });

  it('should have a valid tsup.config.ts for building', () => {
    const tsupConfigPath = path.join(process.cwd(), 'tsup.config.ts');
    expect(fs.existsSync(tsupConfigPath)).toBe(true);

    const tsupConfig = fs.readFileSync(tsupConfigPath, 'utf8');
    expect(tsupConfig).toContain('defineConfig');
    expect(tsupConfig).toContain('entry:');
    expect(tsupConfig).toContain('src/index.ts');
  });

  it('should have a valid README.md file', () => {
    const readmePath = path.join(process.cwd(), 'README.md');
    expect(fs.existsSync(readmePath)).toBe(true);

    const readme = fs.readFileSync(readmePath, 'utf8');
    expect(readme).toContain('# Project Starter');
  });
});
