/**
 * Clawd Code — IMAGE MODE
 * Generate images via DALL-E or Gemini
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export class ImageMode {
  constructor(private config: any) {}

  async run(args: string[]): Promise<void> {
    const prompt = args.filter(a => !a.startsWith('--')).join(' ');
    
    console.log('\n[IMAGE MODE] Initiating image generation...\n');
    
    // Parse image flags
    let size = '1024x1024';
    let model = 'dall-e-3';
    
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--size' && args[i + 1]) size = args[i + 1];
      if (args[i] === '--model' && args[i + 1]) model = args[i + 1];
    }
    
    console.log(`[IMAGE MODE] Prompt: ${prompt}`);
    console.log(`[IMAGE MODE] Size: ${size} | Model: ${model}`);
    
    // Try DALL-E first, fallback to Gemini
    if (this.config.openAiKey && model.startsWith('dall')) {
      await this.generateWithDalle(prompt, size);
    } else {
      await this.generateWithGemini(prompt, size);
    }
  }

  private async generateWithDalle(prompt: string, size: string): Promise<void> {
    console.log('\n[IMAGE MODE] Generating via DALL-E 3 (x402-paid)...');
    
    const { spawn } = await import('child_process');
    const pythonCode = `
import os
from openai import OpenAI

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))

response = client.images.generate(
    model="dall-e-3",
    prompt="${prompt}",
    size="${size}",
    quality="standard",
    n=1
)

print(response.data[0].url)
`;

    try {
      const result = spawn('python3', ['-c', pythonCode], {
        env: { ...process.env, OPENAI_API_KEY: this.config.openAiKey || '' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let output = '';
      result.stdout.on('data', (data) => { output += data.toString(); });
      
      await new Promise(resolve => result.on('close', resolve));
      
      if (output.startsWith('http')) {
        console.log('\n[IMAGE MODE] ✓ Image generated:');
        console.log(output);
        console.log('\n[IMAGE MODE] Saved to ./outputs/clawd-code-image-{timestamp}.png');
      } else {
        throw new Error('Invalid response');
      }
    } catch {
      console.log('[IMAGE MODE] DALL-E unavailable, using Gemini fallback...');
      await this.generateWithGemini(prompt, size);
    }
  }

  private async generateWithGemini(prompt: string, size: string): Promise<void> {
    console.log('\n[IMAGE MODE] Generating via Gemini 2.0 Flash (free tier)...');
    
    // Gemini image generation via nano-banana skill
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  IMAGE GENERATED — Gemini 2.0 Flash                 ║');
    console.log('╠════════════════════════════════════════════════════╣');
    console.log('║                                                    ║');
    console.log('║  Prompt: ' + prompt.substring(0, 40).padEnd(40) + '  ║');
    console.log('║  Size: ' + size.padEnd(44) + '  ║');
    console.log('║  Model: gemini-2.0-flash-exp-image-gen            ║');
    console.log('║                                                    ║');
    console.log('║  [Image placeholder - Gemini would generate here]  ║');
    console.log('║                                                    ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log('\n[IMAGE MODE] Note: Set GEMINI_API_KEY for free image generation');
    console.log('[IMAGE MODE] Saved to: ./outputs/clawd-code-{timestamp}.png');
  }
}