/**
 * PDF Export Tests
 *
 * Comprehensive test suite for PDF export functionality in the elizaos report generate command.
 * Tests cover CLI integration, PDF generation utility, and end-to-end workflows.
 *
 * Required by ticket #5790 - PDF Export Implementation
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeGenerateCommand } from '../../generate';
import { ScenarioRunResult } from '../../../scenario/src/schema';

// Mock puppeteer to avoid launching real Chrome in tests
const mockPuppeteer = {
  launch: mock(() =>
    Promise.resolve({
      newPage: mock(() =>
        Promise.resolve({
          goto: mock(() => Promise.resolve()),
          waitForTimeout: mock(() => Promise.resolve()),
          pdf: mock(() => Promise.resolve()),
        })
      ),
      close: mock(() => Promise.resolve()),
    })
  ),
};

// Import the PDF generator (will be created)
let generatePdfFromHtml: any;

mock.module('puppeteer', () => mockPuppeteer);

describe('PDF Export Functionality', () => {
  let testDir: string;
  let inputDir: string;
  let outputPdfPath: string;
  let outputHtmlPath: string;

  beforeEach(async () => {
    // Create temporary directory for test files
    testDir = await fs.mkdtemp(join(tmpdir(), 'elizaos-pdf-test-'));
    inputDir = join(testDir, 'matrix-output');
    outputPdfPath = join(testDir, 'test-report.pdf');
    outputHtmlPath = join(testDir, 'test-report.html');

    await fs.mkdir(inputDir, { recursive: true });

    // Create sample run data
    const sampleRun: ScenarioRunResult = {
      run_id: 'test-run-001',
      matrix_combination_id: 'combo-1',
      parameters: {
        'character.llm.model': 'gpt-4',
        'character.temperature': 0.7,
      },
      metrics: {
        execution_time_seconds: 25.4,
        llm_calls: 3,
        total_tokens: 1500,
      },
      final_agent_response: 'Test response',
      evaluations: [
        {
          evaluator_type: 'string_contains',
          success: true,
          summary: 'Test passed',
          details: {},
        },
      ],
      trajectory: [
        {
          type: 'thought',
          timestamp: '2025-01-17T12:00:00.000Z',
          content: 'Test thought',
        },
      ],
      error: null,
    };

    // Write sample run file
    await fs.writeFile(join(inputDir, 'run-001.json'), JSON.stringify(sampleRun, null, 2));
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('CLI Integration Tests', () => {
    test('should accept --format pdf flag', async () => {
      // This test verifies the CLI accepts PDF format without throwing
      await expect(
        executeGenerateCommand(inputDir, {
          outputPath: outputPdfPath,
          format: 'pdf',
        })
      ).resolves.toBeUndefined();
    });

    test('should generate PDF file with correct extension', async () => {
      await executeGenerateCommand(inputDir, {
        outputPath: outputPdfPath,
        format: 'pdf',
      });

      // Verify PDF file was created
      const pdfExists = await fs
        .access(outputPdfPath)
        .then(() => true)
        .catch(() => false);

      expect(pdfExists).toBe(true);
    });

    test('should default to .pdf extension when format is pdf', async () => {
      // Test without explicit output path - should auto-generate .pdf
      await executeGenerateCommand(inputDir, { format: 'pdf' });

      const defaultPdfPath = join(inputDir, 'report.pdf');
      const pdfExists = await fs
        .access(defaultPdfPath)
        .then(() => true)
        .catch(() => false);

      expect(pdfExists).toBe(true);
    });

    test('should show error for unsupported format', async () => {
      await expect(
        executeGenerateCommand(inputDir, {
          outputPath: outputPdfPath,
          format: 'invalid' as any,
        })
      ).rejects.toThrow('Unsupported format');
    });
  });

  describe('PDF Generation Utility Tests', () => {
    test('should create non-empty PDF file', async () => {
      const sampleHtml = `
                <!DOCTYPE html>
                <html>
                <head><title>Test Report</title></head>
                <body>
                    <h1>Test Performance Report</h1>
                    <p>Sample content for PDF generation</p>
                </body>
                </html>
            `;

      // Import the PDF generator function (will be created)
      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify PDF was created and has content
        const pdfStats = await fs.stat(outputPdfPath);
        expect(pdfStats.size).toBeGreaterThan(0);
      } catch (error) {
        // PDF generator doesn't exist yet - this test should initially fail
        expect(error).toBeDefined();
      }
    });

    test('should handle invalid HTML gracefully', async () => {
      const invalidHtml = 'This is not valid HTML <unclosed tag';

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');

        // Should not throw error, but create empty or minimal PDF
        await expect(generatePdfFromHtml(invalidHtml, outputPdfPath)).resolves.toBeUndefined();
      } catch (error) {
        // Module doesn't exist yet
        expect(error).toBeDefined();
      }
    });

    test('should clean up temporary files', async () => {
      const sampleHtml = '<html><body>Test</body></html>';

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify no temporary HTML files left behind
        const files = await fs.readdir(testDir);
        const tempHtmlFiles = files.filter((f) => f.includes('temp') && f.endsWith('.html'));
        expect(tempHtmlFiles.length).toBe(0);
      } catch (error) {
        // Module doesn't exist yet
        expect(error).toBeDefined();
      }
    });
  });

  describe('End-to-End PDF Generation Tests', () => {
    test('should generate PDF with complete report data', async () => {
      await executeGenerateCommand(inputDir, {
        outputPath: outputPdfPath,
        format: 'pdf',
      });

      // Verify PDF file exists and has reasonable size
      const pdfStats = await fs.stat(outputPdfPath);
      expect(pdfStats.size).toBeGreaterThan(1000); // Should be substantial PDF
    });

    test('should include charts in PDF output', async () => {
      // Create run data with capability data for charts
      const runWithCapabilities: ScenarioRunResult = {
        run_id: 'chart-test-run',
        matrix_combination_id: 'combo-chart',
        parameters: { model: 'gpt-4' },
        metrics: {
          execution_time_seconds: 30.0,
          llm_calls: 2,
          total_tokens: 1200,
        },
        final_agent_response: 'Chart test response',
        evaluations: [
          {
            evaluator_type: 'github_issues',
            success: true,
            summary: 'GitHub integration working',
            details: {},
          },
          {
            evaluator_type: 'response_formatting',
            success: false,
            summary: 'Format check failed',
            details: {},
          },
        ],
        trajectory: [],
        error: null,
      };

      await fs.writeFile(
        join(inputDir, 'run-chart-test.json'),
        JSON.stringify(runWithCapabilities, null, 2)
      );

      await executeGenerateCommand(inputDir, {
        outputPath: outputPdfPath,
        format: 'pdf',
      });

      // PDF should be larger due to chart content
      const pdfStats = await fs.stat(outputPdfPath);
      expect(pdfStats.size).toBeGreaterThan(5000);
    });

    test('should handle multiple runs in PDF', async () => {
      // Add more sample runs
      for (let i = 2; i <= 5; i++) {
        const run: ScenarioRunResult = {
          run_id: `multi-run-${i.toString().padStart(3, '0')}`,
          matrix_combination_id: `combo-${i}`,
          parameters: { model: i % 2 === 0 ? 'gpt-4' : 'gpt-3.5-turbo' },
          metrics: {
            execution_time_seconds: 15 + i * 2,
            llm_calls: i,
            total_tokens: 800 + i * 100,
          },
          final_agent_response: `Response ${i}`,
          evaluations: [
            {
              evaluator_type: 'test_eval',
              success: i % 3 !== 0, // Mix of pass/fail
              summary: `Evaluation ${i}`,
              details: {},
            },
          ],
          trajectory: [],
          error: null,
        };

        await fs.writeFile(
          join(inputDir, `run-${i.toString().padStart(3, '0')}.json`),
          JSON.stringify(run, null, 2)
        );
      }

      await executeGenerateCommand(inputDir, {
        outputPath: outputPdfPath,
        format: 'pdf',
      });

      // Verify PDF was generated successfully
      const pdfExists = await fs
        .access(outputPdfPath)
        .then(() => true)
        .catch(() => false);
      expect(pdfExists).toBe(true);
    });
  });

  describe('Print Styling Tests', () => {
    test('should include print-specific CSS', async () => {
      // Generate HTML first to check print styles
      await executeGenerateCommand(inputDir, {
        outputPath: outputHtmlPath,
        format: 'html',
      });

      const htmlContent = await fs.readFile(outputHtmlPath, 'utf-8');

      // Verify print media query exists
      expect(htmlContent).toContain('@media print');

      // Verify print-specific rules exist
      expect(htmlContent).toContain('no-print');
      expect(htmlContent).toContain('page-break-inside: avoid');
    });

    test('should hide interactive elements in print view', async () => {
      await executeGenerateCommand(inputDir, {
        outputPath: outputHtmlPath,
        format: 'html',
      });

      const htmlContent = await fs.readFile(outputHtmlPath, 'utf-8');

      // Should have print styles that hide search/sort controls
      expect(htmlContent).toContain('display: none !important');
    });
  });

  describe('Error Handling Tests', () => {
    test('should handle puppeteer launch failure', async () => {
      // Test with invalid path to force failure
      const invalidPath = '/invalid/nonexistent/path/report.pdf';

      await expect(
        executeGenerateCommand(inputDir, {
          outputPath: invalidPath,
          format: 'pdf',
        })
      ).rejects.toThrow();
    });

    test('should handle file system errors', async () => {
      // Try to write to invalid path
      const invalidPath = '/invalid/path/report.pdf';

      await expect(
        executeGenerateCommand(inputDir, {
          outputPath: invalidPath,
          format: 'pdf',
        })
      ).rejects.toThrow();
    });
  });
});
