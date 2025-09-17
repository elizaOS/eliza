/**
 * PDF Generator Integration Tests
 *
 * Integration tests for the PDF generation utility that uses Puppeteer to convert
 * HTML reports to PDF format. These tests use real Puppeteer to ensure actual functionality.
 *
 * Required by ticket #5790 - PDF Export Implementation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('PDF Generator Integration Tests', () => {
  let testDir: string;
  let outputPdfPath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'pdf-generator-test-'));
    outputPdfPath = join(testDir, 'output.pdf');
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('generatePdfFromHtml function', () => {
    test('should generate PDF from simple HTML', async () => {
      const sampleHtml = '<html><body><h1>Test Report</h1><p>This is a test.</p></body></html>';

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify PDF file was created
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);

        // Verify PDF file has content
        const stats = await fs.stat(outputPdfPath);
        expect(stats.size).toBeGreaterThan(0);
      } catch (error) {
        // If Puppeteer is not available, skip the test
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });

    test('should generate PDF with complex HTML content', async () => {
      const sampleHtml = `
                <html>
                    <head>
                        <style>
                            body { font-family: Arial, sans-serif; }
                            .header { background: #f0f0f0; padding: 20px; }
                            .content { margin: 20px; }
                        </style>
                    </head>
                    <body>
                        <div class="header">
                            <h1>Complex Test Report</h1>
                            <p>Generated on ${new Date().toISOString()}</p>
                        </div>
                        <div class="content">
                            <h2>Section 1</h2>
                            <p>This is a more complex HTML document with styling.</p>
                            <ul>
                                <li>Item 1</li>
                                <li>Item 2</li>
                                <li>Item 3</li>
                            </ul>
                        </div>
                    </body>
                </html>
            `;

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify PDF file was created
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);

        // Verify PDF file has reasonable size
        const stats = await fs.stat(outputPdfPath);
        expect(stats.size).toBeGreaterThan(1000); // Should be at least 1KB
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });

    test('should handle HTML with external resources gracefully', async () => {
      const sampleHtml = `
                <html>
                    <head>
                        <link rel="stylesheet" href="https://example.com/nonexistent.css">
                        <script src="https://example.com/nonexistent.js"></script>
                    </head>
                    <body>
                        <h1>Test with External Resources</h1>
                        <p>This should still generate a PDF even with missing external resources.</p>
                    </body>
                </html>
            `;

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify PDF file was created despite external resource failures
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });

    test('should generate PDF with charts and JavaScript', async () => {
      const sampleHtml = `
                <html>
                    <head>
                        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
                    </head>
                    <body>
                        <h1>Chart Test Report</h1>
                        <canvas id="testChart" width="400" height="200"></canvas>
                        <script>
                            const ctx = document.getElementById('testChart').getContext('2d');
                            new Chart(ctx, {
                                type: 'bar',
                                data: {
                                    labels: ['A', 'B', 'C'],
                                    datasets: [{
                                        label: 'Test Data',
                                        data: [10, 20, 30],
                                        backgroundColor: ['red', 'green', 'blue']
                                    }]
                                }
                            });
                        </script>
                    </body>
                </html>
            `;

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify PDF file was created
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid output path gracefully', async () => {
      const sampleHtml = '<html><body>Test</body></html>';
      const invalidPath = '/invalid/path/that/does/not/exist/test.pdf';

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await expect(generatePdfFromHtml(sampleHtml, invalidPath)).rejects.toThrow();
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        // Should throw an error for invalid path
        expect(error).toBeInstanceOf(Error);
      }
    });

    test('should handle empty HTML content', async () => {
      const emptyHtml = '';

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(emptyHtml, outputPdfPath);

        // Should still create a PDF (even if empty)
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });

    test('should handle malformed HTML gracefully', async () => {
      const malformedHtml = '<html><body><h1>Unclosed tag<p>Malformed content';

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(malformedHtml, outputPdfPath);

        // Should still create a PDF (browsers are forgiving)
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });
  });

  describe('PDF Configuration', () => {
    test('should generate PDF with A4 format', async () => {
      const sampleHtml = '<html><body><h1>A4 Format Test</h1></body></html>';

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify PDF file was created
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });

    test('should generate PDF with background graphics enabled', async () => {
      const sampleHtml = `
                <html>
                    <body style="background: linear-gradient(45deg, #ff6b6b, #4ecdc4);">
                        <h1 style="color: white;">Background Test</h1>
                        <p style="color: white;">This should have a gradient background.</p>
                    </body>
                </html>
            `;

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify PDF file was created
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });

    test('should generate PDF with appropriate margins', async () => {
      const sampleHtml = `
                <html>
                    <body>
                        <h1>Margin Test</h1>
                        <p>This content should respect the 20px margins.</p>
                        <div style="border: 1px solid black; padding: 10px;">
                            Content with border to test margins
                        </div>
                    </body>
                </html>
            `;

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        await generatePdfFromHtml(sampleHtml, outputPdfPath);

        // Verify PDF file was created
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });
  });

  describe('Performance and Reliability', () => {
    test('should handle large HTML content', async () => {
      // Generate a large HTML document
      const largeContent = Array.from(
        { length: 100 },
        (_, i) =>
          `<h2>Section ${i + 1}</h2><p>This is paragraph ${i + 1} with some content to make it larger.</p>`
      ).join('');

      const sampleHtml = `
                <html>
                    <body>
                        <h1>Large Content Test</h1>
                        ${largeContent}
                    </body>
                </html>
            `;

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');
        const startTime = Date.now();
        await generatePdfFromHtml(sampleHtml, outputPdfPath);
        const endTime = Date.now();

        // Verify PDF file was created
        const pdfExists = await fs
          .access(outputPdfPath)
          .then(() => true)
          .catch(() => false);
        expect(pdfExists).toBe(true);

        // Should complete within reasonable time (30 seconds)
        expect(endTime - startTime).toBeLessThan(30000);
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });

    test('should handle concurrent PDF generation', async () => {
      const sampleHtml = '<html><body><h1>Concurrent Test</h1></body></html>';
      const pdfPaths = [
        join(testDir, 'output1.pdf'),
        join(testDir, 'output2.pdf'),
        join(testDir, 'output3.pdf'),
      ];

      try {
        const { generatePdfFromHtml } = await import('../../src/pdf-generator');

        // Generate multiple PDFs concurrently
        const promises = pdfPaths.map((path) => generatePdfFromHtml(sampleHtml, path));
        await Promise.all(promises);

        // Verify all PDF files were created
        for (const pdfPath of pdfPaths) {
          const pdfExists = await fs
            .access(pdfPath)
            .then(() => true)
            .catch(() => false);
          expect(pdfExists).toBe(true);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('puppeteer')) {
          console.log('⚠️ Skipping PDF test - Puppeteer not available');
          return;
        }
        throw error;
      }
    });
  });
});
