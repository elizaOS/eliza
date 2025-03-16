import path from 'node:path';
import dotenv from 'dotenv';

// Load test environment variables
const envPath = path.resolve(__dirname, '../../.env.test');
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.error('Error loading .env.test:', result.error);
}
