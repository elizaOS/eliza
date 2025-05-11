import dotenv from 'dotenv';

const result = dotenv.config({ path: '../../.env.test' });
if (result.error) {
  console.error('Error loading .env.test. Loading .env instead');
  const result2 = dotenv.config({ path: '../../.env' });
  if (result2.error) {
    console.error('Error loading .env:', result2.error);
  }
}
