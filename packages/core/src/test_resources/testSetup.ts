import dotenv from 'dotenv';

const result = dotenv.config({ path: '../../.env.test' });
if (result.error) {
  console.error('Error loading .env.test:', result.error);
}
