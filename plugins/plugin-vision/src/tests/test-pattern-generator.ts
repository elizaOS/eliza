import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '@elizaos/core';

export interface TestPatternConfig {
  width: number;
  height: number;
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  includeGrid?: boolean;
  includeTimestamp?: boolean;
  displayIndex?: number;
}

export class TestPatternGenerator {
  /**
   * Generate a test pattern with numbers in each quadrant and center
   */
  static async generateQuadrantPattern(config: TestPatternConfig): Promise<Buffer> {
    const {
      width,
      height,
      backgroundColor = '#ffffff',
      textColor = '#000000',
      fontSize = 48,
      includeGrid = true,
      includeTimestamp = true,
      displayIndex = 0,
    } = config;

    // Create SVG with test pattern
    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <!-- Background -->
        <rect width="${width}" height="${height}" fill="${backgroundColor}"/>
        
        ${includeGrid ? this.generateGrid(width, height) : ''}
        
        <!-- Quadrant dividers -->
        <line x1="${width / 2}" y1="0" x2="${width / 2}" y2="${height}" stroke="#cccccc" stroke-width="2"/>
        <line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" stroke="#cccccc" stroke-width="2"/>
        
        <!-- Quadrant numbers -->
        <text x="${width / 4}" y="${height / 4}" font-family="Arial" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">1</text>
        <text x="${(3 * width) / 4}" y="${height / 4}" font-family="Arial" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">2</text>
        <text x="${width / 4}" y="${(3 * height) / 4}" font-family="Arial" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">3</text>
        <text x="${(3 * width) / 4}" y="${(3 * height) / 4}" font-family="Arial" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">4</text>
        
        <!-- Center number -->
        <circle cx="${width / 2}" cy="${height / 2}" r="${fontSize}" fill="#ff0000" opacity="0.3"/>
        <text x="${width / 2}" y="${height / 2}" font-family="Arial" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">5</text>
        
        <!-- Display info -->
        <text x="20" y="30" font-family="Arial" font-size="16" fill="${textColor}">Display ${displayIndex}</text>
        <text x="20" y="50" font-family="Arial" font-size="16" fill="${textColor}">${width}x${height}</text>
        
        ${includeTimestamp ? `<text x="20" y="70" font-family="Arial" font-size="16" fill="${textColor}">Time: ${new Date().toISOString()}</text>` : ''}
        
        <!-- Corner markers -->
        <circle cx="10" cy="10" r="5" fill="#ff0000"/>
        <circle cx="${width - 10}" cy="10" r="5" fill="#00ff00"/>
        <circle cx="10" cy="${height - 10}" r="5" fill="#0000ff"/>
        <circle cx="${width - 10}" cy="${height - 10}" r="5" fill="#ffff00"/>
      </svg>
    `;

    // Convert SVG to PNG
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();

    return buffer;
  }

  /**
   * Generate a complex test pattern with multiple text regions
   */
  static async generateComplexPattern(config: TestPatternConfig): Promise<Buffer> {
    const {
      width,
      height,
      backgroundColor = '#f0f0f0',
      textColor = '#000000',
      fontSize = 24,
      displayIndex = 0,
    } = config;

    // Sample text for OCR testing
    const sampleTexts = [
      'The quick brown fox jumps over the lazy dog',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'abcdefghijklmnopqrstuvwxyz',
      '0123456789',
      '!@#$%^&*()_+-=[]{}|;:,.<>?',
    ];

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <!-- Background -->
        <rect width="${width}" height="${height}" fill="${backgroundColor}"/>
        
        <!-- Title -->
        <text x="${width / 2}" y="50" font-family="Arial" font-size="32" fill="${textColor}" text-anchor="middle">Vision Test Pattern - Display ${displayIndex}</text>
        
        <!-- Text regions for OCR testing -->
        ${sampleTexts
          .map(
            (text, i) => `
          <rect x="50" y="${150 + i * 80}" width="${width - 100}" height="60" fill="white" stroke="#333" stroke-width="1"/>
          <text x="70" y="${185 + i * 80}" font-family="Arial" font-size="${fontSize}" fill="${textColor}">${text}</text>
        `
          )
          .join('')}
        
        <!-- UI Elements -->
        <rect x="50" y="${height - 200}" width="150" height="40" fill="#007bff" rx="5"/>
        <text x="125" y="${height - 175}" font-family="Arial" font-size="16" fill="white" text-anchor="middle">Button</text>
        
        <rect x="220" y="${height - 200}" width="200" height="30" fill="white" stroke="#333" stroke-width="1"/>
        <text x="230" y="${height - 180}" font-family="Arial" font-size="14" fill="#666">Input Field</text>
        
        <!-- Timestamp -->
        <text x="${width - 20}" y="${height - 20}" font-family="Arial" font-size="12" fill="#666" text-anchor="end">${new Date().toISOString()}</text>
      </svg>
    `;

    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();

    return buffer;
  }

  /**
   * Generate grid lines for the pattern
   */
  private static generateGrid(width: number, height: number, spacing: number = 100): string {
    const lines: string[] = [];

    // Vertical lines
    for (let x = spacing; x < width; x += spacing) {
      lines.push(
        `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#eeeeee" stroke-width="1"/>`
      );
    }

    // Horizontal lines
    for (let y = spacing; y < height; y += spacing) {
      lines.push(
        `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#eeeeee" stroke-width="1"/>`
      );
    }

    return lines.join('\n');
  }

  /**
   * Save test pattern to file
   */
  static async savePattern(buffer: Buffer, filename: string): Promise<string> {
    const outputDir = path.join(process.cwd(), 'test-patterns');
    await fs.mkdir(outputDir, { recursive: true });

    const filepath = path.join(outputDir, filename);
    await fs.writeFile(filepath, buffer);

    logger.info(`[TestPatternGenerator] Saved test pattern to ${filepath}`);
    return filepath;
  }

  /**
   * Generate patterns for all displays
   */
  static async generatePatternsForAllDisplays(displayCount: number): Promise<Map<number, Buffer>> {
    const patterns = new Map<number, Buffer>();

    for (let i = 0; i < displayCount; i++) {
      const pattern = await this.generateQuadrantPattern({
        width: 1920,
        height: 1080,
        displayIndex: i,
        includeTimestamp: true,
      });

      patterns.set(i, pattern);
    }

    return patterns;
  }

  /**
   * Verify OCR results match expected quadrant numbers
   */
  static verifyQuadrantNumbers(ocrText: string): {
    success: boolean;
    foundNumbers: number[];
    missingNumbers: number[];
  } {
    const expectedNumbers = [1, 2, 3, 4, 5];
    const foundNumbers: number[] = [];

    // Extract all numbers from OCR text
    const matches = ocrText.match(/\d+/g);
    if (matches) {
      matches.forEach((match) => {
        const num = parseInt(match, 10);
        if (expectedNumbers.includes(num) && !foundNumbers.includes(num)) {
          foundNumbers.push(num);
        }
      });
    }

    const missingNumbers = expectedNumbers.filter((n) => !foundNumbers.includes(n));

    return {
      success: missingNumbers.length === 0,
      foundNumbers,
      missingNumbers,
    };
  }
}
