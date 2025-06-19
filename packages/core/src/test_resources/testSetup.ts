import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths relative to packages/core directory
const packageRoot = path.resolve(__dirname, '../..');
const envTestPath = path.join(packageRoot, '.env.test');
const envPath = path.join(packageRoot, '.env');

const result = dotenv.config({ path: envTestPath });
if (result.error) {
  console.error('Error loading .env.test. Loading .env instead');
  const result2 = dotenv.config({ path: envPath });
  if (result2.error) {
    console.error('Error loading .env:', result2.error);
  }
}
