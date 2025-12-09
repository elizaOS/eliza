import { expect, test, describe } from 'bun:test';
import React from 'react';

declare const Bun: {
  file(path: string): {
    exists(): Promise<boolean>;
    text(): Promise<string>;
  };
};

declare const process: {
  cwd(): string;
};

describe('App Tests', () => {
  test('main.tsx file exists and contains expected structure', async () => {
    const mainPath = `${process.cwd()}/src/main.tsx`;
    const file = Bun.file(mainPath);
    expect(await file.exists()).toBe(true);

    const content = await file.text();

    expect(content).toContain('useState');
    expect(content).toContain('createRoot');
    expect(content).toContain('ElizaWrapper');
    expect(content).toContain('fetch');
  });

  test('React can be imported and used', () => {
    expect(React).toBeDefined();

    const element = React.createElement('div', { className: 'test' }, 'Test Content');

    expect(element).toBeDefined();
    expect(element.type).toBe('div');
    expect(element.props.className).toBe('test');
  });

  test('package has correct dependencies', async () => {
    interface PackageJson {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }

    const packageJsonPath = `${process.cwd()}/package.json`;
    const file = Bun.file(packageJsonPath);
    const packageJson = JSON.parse(await file.text()) as PackageJson;

    expect(packageJson.dependencies).toBeDefined();
    expect(packageJson.dependencies?.['react']).toBeDefined();
    expect(packageJson.dependencies?.['react-dom']).toBeDefined();

    expect(packageJson.devDependencies).toBeDefined();
    expect(packageJson.devDependencies?.['@tauri-apps/cli']).toBeDefined();
    expect(packageJson.devDependencies?.['typescript']).toBeDefined();
  });

  test('project has correct file structure', async () => {
    const srcPath = `${process.cwd()}/src`;
    expect(await Bun.file(srcPath).exists()).toBe(false);
    expect(await Bun.file(`${srcPath}/main.tsx`).exists()).toBe(true);

    const srcTauriPath = `${process.cwd()}/src-tauri`;
    expect(await Bun.file(srcTauriPath).exists()).toBe(false);
    expect(await Bun.file(`${srcTauriPath}/Cargo.toml`).exists()).toBe(true);
  });
});
