import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

describe('Environment Setup', () => {
  it('should verify configuration files exist', () => {
    const requiredFiles = [
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'build.ts',
      'bunfig.toml',
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(projectRoot, file);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it('should have proper src directory structure', () => {
    const srcDir = path.join(projectRoot, 'src');
    expect(fs.existsSync(srcDir)).toBe(true);

    const requiredSrcFiles = ['index.ts', 'plugin.ts'];

    for (const file of requiredSrcFiles) {
      const filePath = path.join(srcDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it('should have a valid package.json with required fields', () => {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    expect(fs.existsSync(packageJsonPath)).toBe(true);

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    expect(packageJson).toHaveProperty('name');
    expect(typeof packageJson.name).toBe('string');
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
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    expect(fs.existsSync(tsconfigPath)).toBe(true);

    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    expect(tsconfig).toHaveProperty('compilerOptions');

    // Check compiler options
    expect(tsconfig.compilerOptions).toHaveProperty('target');
    expect(tsconfig.compilerOptions).toHaveProperty('module');
    expect(tsconfig.compilerOptions).toHaveProperty('moduleResolution');
    expect(tsconfig.compilerOptions).toHaveProperty('esModuleInterop');
  });

  it('should have a valid build.ts for building', () => {
    const buildScriptPath = path.join(projectRoot, 'build.ts');
    expect(fs.existsSync(buildScriptPath)).toBe(true);

    const buildScript = fs.readFileSync(buildScriptPath, 'utf8');
    expect(buildScript).toContain('Bun.build');
    expect(buildScript).toContain('entrypoints');
    expect(buildScript).toContain('src/index.ts');
  });

  it('should have a valid README.md file', () => {
    const readmePath = path.join(projectRoot, 'README.md');
    expect(fs.existsSync(readmePath)).toBe(true);

    const readme = fs.readFileSync(readmePath, 'utf8');
    expect(readme).toContain('# Project Starter');
  });
});
