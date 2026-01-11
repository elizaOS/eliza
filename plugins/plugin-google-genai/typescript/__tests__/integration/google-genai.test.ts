/**
 * Integration tests for the Google GenAI plugin.
 *
 * These tests require a valid GOOGLE_GENERATIVE_AI_API_KEY environment variable.
 */

import { describe, expect, it, beforeAll } from 'bun:test';
import { config } from 'dotenv';

// Load environment variables
config();

const hasApiKey = !!process.env['GOOGLE_GENERATIVE_AI_API_KEY'];

describe('Google GenAI Integration', () => {
  beforeAll(() => {
    if (!hasApiKey) {
      console.log('Skipping integration tests: GOOGLE_GENERATIVE_AI_API_KEY not set');
    }
  });

  describe.skipIf(!hasApiKey)('API Integration', () => {
    it('should validate API key by listing models', async () => {
      const { GoogleGenAI } = await import('@google/genai');
      
      const apiKey = process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
      expect(apiKey).toBeDefined();
      
      const genAI = new GoogleGenAI({ apiKey: apiKey! });
      const modelList = await genAI.models.list();
      
      const models = [];
      for await (const model of modelList) {
        models.push(model);
      }
      
      expect(models.length).toBeGreaterThan(0);
    });

    it('should generate text with small model', async () => {
      const { GoogleGenAI } = await import('@google/genai');
      
      const apiKey = process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
      const genAI = new GoogleGenAI({ apiKey: apiKey! });
      
      const response = await genAI.models.generateContent({
        model: 'gemini-2.0-flash-001',
        contents: 'What is 2+2? Answer with just the number.',
        config: {
          maxOutputTokens: 10,
        },
      });
      
      expect(response.text).toBeDefined();
      expect(response.text).toContain('4');
    });

    it('should generate embeddings', async () => {
      const { GoogleGenAI } = await import('@google/genai');
      
      const apiKey = process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
      const genAI = new GoogleGenAI({ apiKey: apiKey! });
      
      const response = await genAI.models.embedContent({
        model: 'text-embedding-004',
        contents: 'Hello, world!',
      });
      
      expect(response.embeddings).toBeDefined();
      expect(response.embeddings?.length).toBeGreaterThan(0);
      expect(response.embeddings?.[0]?.values?.length).toBeGreaterThan(0);
    });

    it('should generate JSON object', async () => {
      const { GoogleGenAI } = await import('@google/genai');
      
      const apiKey = process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
      const genAI = new GoogleGenAI({ apiKey: apiKey! });
      
      const response = await genAI.models.generateContent({
        model: 'gemini-2.0-flash-001',
        contents: 'Create a JSON object with a "greeting" field that says "hello".',
        config: {
          responseMimeType: 'application/json',
        },
      });
      
      expect(response.text).toBeDefined();
      
      const parsed = JSON.parse(response.text || '{}');
      expect(parsed).toBeDefined();
    });
  });
});


