import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

/**
 * Load environment variables from .env files in multiple possible locations
 * and ensure they are properly injected into process.env
 */
export function loadEnvironmentVariables(): void {
  // Try loading .env from multiple locations
  const possibleEnvPaths = [
    path.join(process.cwd(), '.env'), // Project root
    path.join(__dirname, '..', '..', '.env'), // CLI package root
    path.join(__dirname, '..', '..', '..', '..', '.env'), // Monorepo root
  ];

  let loadedFrom = null;

  for (const envPath of possibleEnvPaths) {
    if (fs.existsSync(envPath)) {
      console.log(`[ENV] Loading environment from: ${envPath}`);
      const envFileContent = fs.readFileSync(envPath);
      const parsedEnv = dotenv.parse(envFileContent);

      // Manually inject parsed env vars into process.env
      for (const key in parsedEnv) {
        if (process.env[key] === undefined) {
          process.env[key] = parsedEnv[key];
        }
      }

      loadedFrom = envPath;
      console.log(`[ENV] Environment loaded with ${Object.keys(parsedEnv).length} variables`);
      break; // Use the first found .env file
    }
  }

  if (!loadedFrom) {
    console.log('[ENV] No .env file found in any of the expected locations');
  }

  // Verify critical environment variables are loaded
  const criticalVars = ['OPENAI_API_KEY'];
  for (const varName of criticalVars) {
    if (process.env[varName]) {
      const valuePreview = (process.env[varName] || '').toString();
      const redacted =
        valuePreview.length > 8
          ? `${valuePreview.slice(0, 4)}****${valuePreview.slice(-4)}`
          : '****';
      console.log(`[ENV] ${varName} found in process.env: ${redacted}`);
    } else {
      console.log(`[ENV] ⚠️ ${varName} not found in process.env`);
    }
  }

  // Debug dump of a safe subset of env
  const safeKeys = ['NODE_ENV', 'OPENAI_API_KEY'];
  const safeEnv: Record<string, string> = {};
  for (const key of safeKeys) {
    if (process.env[key]) {
      const val = process.env[key] as string;
      safeEnv[key] = val.length > 8 ? `${val.slice(0, 4)}****${val.slice(-4)}` : '****';
    } else {
      safeEnv[key] = '<missing>';
    }
  }
  console.log('[ENV] Safe env preview:', JSON.stringify(safeEnv));
}
