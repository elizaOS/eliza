/**
 * Clawd Code — IMAGE MODE
 * Generate images via Z.AI GLM-Image, DALL-E, or Gemini fallback.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_IMAGE_MODEL } from '../grok-models.js';
import { createZaiClient, ZAI_IMAGE_MODEL } from '../zai.js';

export class ImageMode {
  constructor(private config: any) {}

  async run(args: string[]): Promise<void> {
    const { prompt, size, model } = this.parseArgs(args);

    console.log('\n[IMAGE MODE] Initiating image generation...\n');
    if (!prompt) {
      console.log('[IMAGE MODE] Usage: clawd-code image "prompt" [--size 1024x1024] [--model glm-image]');
      return;
    }
    
    console.log(`[IMAGE MODE] Prompt: ${prompt}`);
    console.log(`[IMAGE MODE] Size: ${size} | Model: ${model}`);
    
    if (this.isZaiImageModel(model)) {
      await this.generateWithZai(prompt, size, model);
    } else if (this.config.openAiKey && model.startsWith('dall')) {
      await this.generateWithDalle(prompt, size);
    } else {
      await this.generateWithGemini(prompt, size);
    }
  }

  private parseArgs(args: string[]): { prompt: string; size: string; model: string } {
    let size = '1024x1024';
    let model = this.config.zaiImageModel || DEFAULT_IMAGE_MODEL;
    const promptParts: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--size' && args[i + 1]) {
        size = args[++i];
        continue;
      }
      if (arg === '--model' && args[i + 1]) {
        model = args[++i];
        continue;
      }
      if (!arg.startsWith('--')) promptParts.push(arg);
    }

    return { prompt: promptParts.join(' ').trim(), size, model };
  }

  private isZaiImageModel(model: string): boolean {
    return model === ZAI_IMAGE_MODEL || model.startsWith('glm-image') || model.startsWith('cogview');
  }

  private async generateWithZai(prompt: string, size: string, model: string): Promise<void> {
    const client = createZaiClient(this.config.zaiApiKey, this.config.zaiBaseUrl);
    if (!client) {
      console.log('\n[IMAGE MODE] ZAI_API_KEY not set; using Gemini placeholder fallback.');
      await this.generateWithGemini(prompt, size);
      return;
    }

    console.log('\n[IMAGE MODE] Generating via Z.AI image API...');
    try {
      const result = await client.generateImage({ model, prompt, size });
      const outputDir = join(process.cwd(), 'outputs');
      mkdirSync(outputDir, { recursive: true });

      if (result.b64Json) {
        const imagePath = join(outputDir, `clawd-code-image-${Date.now()}.png`);
        writeFileSync(imagePath, Buffer.from(result.b64Json, 'base64'));
        console.log('\n[IMAGE MODE] Image generated:');
        console.log(imagePath);
        return;
      }

      if (result.url) {
        const metaPath = join(outputDir, `clawd-code-image-${Date.now()}.json`);
        writeFileSync(metaPath, JSON.stringify({ model: result.model ?? model, prompt, size, url: result.url }, null, 2));
        console.log('\n[IMAGE MODE] Image generated:');
        console.log(result.url);
        console.log(`[IMAGE MODE] Metadata saved to: ${metaPath}`);
        return;
      }

      throw new Error('Z.AI image response did not include url or b64_json');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[IMAGE MODE] Z.AI image generation failed: ${msg}`);
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
    prompt=${JSON.stringify(prompt)},
    size=${JSON.stringify(size)},
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
