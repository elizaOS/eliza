import * as fs from 'fs-extra';
import * as path from 'node:path';
import { globby } from 'globby';
import { logger } from '@elizaos/core';
import type { FileAnalysis } from '../types.js';

/**
 * Analyze file content for migration complexity and patterns
 */
export async function analyzeFileContent(filePath: string): Promise<FileAnalysis> {
  const content = await fs.readFile(filePath, 'utf-8');
  
  return {
    hasV1Imports: /from\s+["']@ai16z\/eliza["']/.test(content),
    hasV1ServicePattern: /export\s+(const|let|var)\s+\w+Service\s*=/.test(content),
    hasV1ActionPattern: /handler:\s*async.*Promise<boolean>/.test(content),
    hasV1MemoryPattern: /runtime\.memory\.create|runtime\.messageManager\.createMemory/.test(content),
    hasV1ConfigPattern: /process\.env\.\w+(?!\s*\|\|\s*runtime\.getSetting)/.test(content),
    hasV1ModelAPI: /runtime\.language\.generateText|ModelClass/.test(content),
    hasV1TestPattern: /__tests__|vitest|jest/.test(content),
    complexityScore: calculateComplexity(content),
    v1PatternCount: countV1Patterns(content)
  };
}

/**
 * Calculate complexity score for migration planning
 */
export function calculateComplexity(content: string): number {
  let score = 0;
  
  // Basic complexity indicators
  score += (content.match(/class\s+\w+/g) || []).length * 2; // Classes
  score += (content.match(/function\s+\w+|const\s+\w+\s*=\s*async/g) || []).length; // Functions
  score += (content.match(/import\s+.*from/g) || []).length * 0.5; // Imports
  score += (content.match(/export\s+/g) || []).length * 0.5; // Exports
  
  // V1 specific complexity
  score += (content.match(/ModelClass|elizaLogger|runtime\.memory\./g) || []).length * 3;
  score += (content.match(/Promise<boolean>/g) || []).length * 2;
  
  return Math.round(score);
}

/**
 * Count V1 patterns for migration assessment
 */
export function countV1Patterns(content: string): number {
  const v1Patterns = [
    /ModelClass/g,
    /elizaLogger/g,
    /runtime\.memory\.create/g,
    /runtime\.messageManager\.createMemory/g,
    /runtime\.language\.generateText/g,
    /user:\s*["']/g,
    /stop:\s*\[/g,
    /max_tokens:/g,
    /Promise<boolean>/g
  ];
  
  return v1Patterns.reduce((count, pattern) => {
    return count + (content.match(pattern) || []).length;
  }, 0);
}

/**
 * More accurate service detection that avoids false positives
 */
export async function detectActualService(files: string[], repoPath: string): Promise<boolean> {
    // First check: Look for service files in the right location
    const serviceFiles = files.filter(f => {
      const fileName = path.basename(f);
      const isInSrc = f.includes('src/');
      const isServiceFile = fileName === 'service.ts' || 
                           fileName === 'Service.ts' ||
                           fileName.endsWith('/service.ts') ||
                           fileName.endsWith('/Service.ts');
      
      return isInSrc && isServiceFile;
    });
    
    if (serviceFiles.length === 0) {
      return false;
    }
    
    // Second check: Analyze the content to confirm it's an actual ElizaOS service
    for (const serviceFile of serviceFiles) {
      const fullPath = path.join(repoPath, serviceFile);
      
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        
        // Check for ElizaOS service patterns
        const hasServiceClass = /class\s+\w+Service\s+extends\s+Service/.test(content);
        const hasServiceType = /static\s+serviceType/.test(content);
        const hasStartMethod = /static\s+async\s+start/.test(content);
        const hasElizaImports = /@elizaos\/core|@ai16z\/eliza/.test(content);
        
        // If it has service patterns, it's likely a real service
        if ((hasServiceClass || hasServiceType || hasStartMethod) && hasElizaImports) {
          logger.info(`✅ Found valid ElizaOS service in ${serviceFile}`);
          return true;
        }
      }
    }
    
    // Third check: Look for service exports in index.ts
    const indexFiles = files.filter(f => 
      f.endsWith('src/index.ts') || f.endsWith('index.ts')
    );
    
    for (const indexFile of indexFiles) {
      const fullPath = path.join(repoPath, indexFile);
      
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        
        // Check if services array has entries
        const servicesPattern = /services:\s*\[([^\]]+)\]/;
        const match = content.match(servicesPattern);
        
        if (match && match[1].trim() !== '') {
          logger.info(`✅ Found service registration in ${indexFile}`);
          return true;
        }
      }
    }
    
    logger.info('🔍 No valid ElizaOS service detected');
    return false;
  }

/**
 * Validate that all imports are V2 compliant
 */
export async function validateV2Imports(repoPath: string): Promise<string[]> {
  const issues: string[] = [];
  const sourceFiles = await globby(['src/**/*.ts'], {
    cwd: repoPath,
    ignore: ['node_modules/**', 'dist/**']
  });

  for (const file of sourceFiles) {
    const filePath = path.join(repoPath, file);
    const content = await fs.readFile(filePath, 'utf-8');

    // Check for mixed imports that should be separated
    const mixedImportPattern = /import\s*{\s*([^}]*),\s*type\s+([^}]*)\s*}\s*from\s*["']@elizaos\/core["']/g;
    if (mixedImportPattern.test(content)) {
      issues.push(`${file}: Contains mixed imports that should be separated`);
    }

    // Check for value imports that should be type imports
    const typeOnlyImports = ['TestSuite', 'ActionExample', 'Content', 'HandlerCallback', 'IAgentRuntime', 'State', 'UUID', 'Plugin'];
    for (const typeImport of typeOnlyImports) {
      const valueImportPattern = new RegExp(`import\\s*{[^}]*\\b${typeImport}\\b[^}]*}\\s*from\\s*["']@elizaos\\/core["']`, 'g');
      if (valueImportPattern.test(content) && !content.includes('import type')) {
        issues.push(`${file}: '${typeImport}' should be imported as type`);
      }
    }
  }

  return issues;
}

/**
 * Validate package.json V2 compliance
 */
export async function validatePackageJson(repoPath: string): Promise<string[]> {
  const issues: string[] = [];
  
  const packageJsonPath = path.join(repoPath, 'package.json');
  const packageJson = await fs.readJson(packageJsonPath);

  // Check required fields
  if (packageJson.type !== 'module') {
    issues.push('package.json missing "type": "module"');
  }

  if (!packageJson.exports) {
    issues.push('package.json missing exports field');
  }

  // Check for V1 dependencies that should be removed
  const v1Dependencies = ['vitest', 'jest', '@ai16z/eliza'];
  for (const dep of v1Dependencies) {
    if (packageJson.dependencies?.[dep] || packageJson.devDependencies?.[dep]) {
      issues.push(`package.json contains V1 dependency: ${dep}`);
    }
  }

  // Check for required V2 dependencies
  if (!packageJson.dependencies?.['@elizaos/core']) {
    issues.push('package.json missing @elizaos/core dependency');
  }

  return issues;
}

/**
 * Get dummy value for environment variable (for testing)
 */
export function getDummyValueForEnvVar(envVar: string): string {
  const lowercaseVar = envVar.toLowerCase();
  
  if (lowercaseVar.includes('api_key') || lowercaseVar.includes('token')) {
    return 'dummy_api_key_for_testing';
  }
  if (lowercaseVar.includes('secret')) {
    return 'dummy_secret_for_testing';
  }
  if (lowercaseVar.includes('url') || lowercaseVar.includes('endpoint')) {
    return 'https://example.com';
  }
  if (lowercaseVar.includes('port')) {
    return '3000';
  }
  if (lowercaseVar.includes('host')) {
    return 'localhost';
  }
  if (lowercaseVar.includes('database') || lowercaseVar.includes('db')) {
    return 'test_database';
  }
  if (lowercaseVar.includes('user') || lowercaseVar.includes('username')) {
    return 'test_user';
  }
  if (lowercaseVar.includes('password')) {
    return 'test_password';
  }
  if (lowercaseVar.includes('model')) {
    return 'test_model';
  }
  if (lowercaseVar.includes('path')) {
    return '/tmp/test_path';
  }
  if (lowercaseVar.includes('bool') || lowercaseVar.includes('enable') || lowercaseVar.includes('disable')) {
    return 'true';
  }
  
  // Default fallback
  return 'test_value';
} 