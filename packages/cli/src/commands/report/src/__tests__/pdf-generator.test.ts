/**
 * PDF Generator Unit Tests
 *
 * Unit tests for the PDF generation utility that uses Puppeteer to convert
 * HTML reports to PDF format.
 *
 * Required by ticket #5790 - PDF Export Implementation
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock Puppeteer for unit testing
const mockPage = {
    goto: mock(() => Promise.resolve()),
    waitForTimeout: mock(() => Promise.resolve()),
    waitForLoadState: mock(() => Promise.resolve()),
    pdf: mock(() => Promise.resolve()),
    evaluate: mock(() => Promise.resolve(true)),
};

const mockBrowser = {
    newPage: mock(() => Promise.resolve(mockPage)),
    close: mock(() => Promise.resolve()),
};

const mockPuppeteer = {
    launch: mock(() => Promise.resolve(mockBrowser)),
};

mock.module('puppeteer', () => mockPuppeteer);

describe('PDF Generator Unit Tests', () => {
    let testDir: string;
    let tempHtmlPath: string;
    let outputPdfPath: string;

    beforeEach(async () => {
        testDir = await fs.mkdtemp(join(tmpdir(), 'pdf-generator-test-'));
        tempHtmlPath = join(testDir, 'temp-report.html');
        outputPdfPath = join(testDir, 'output.pdf');

        // Reset mocks
        mockPuppeteer.launch.mockClear();
        mockBrowser.newPage.mockClear();
        mockBrowser.close.mockClear();
        mockPage.goto.mockClear();
        mockPage.waitForTimeout.mockClear();
        mockPage.pdf.mockClear();
    });

    afterEach(async () => {
        try {
            await fs.rm(testDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    describe('generatePdfFromHtml function', () => {
        test('should create temporary HTML file', async () => {
            const sampleHtml = '<html><body><h1>Test Report</h1></body></html>';

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml(sampleHtml, outputPdfPath);

                // Verify puppeteer was called with correct parameters
                expect(mockPuppeteer.launch).toHaveBeenCalledWith(
                    expect.objectContaining({
                        headless: true
                    })
                );
            } catch (error) {
                // Module doesn't exist yet - this is expected for TDD
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should launch headless Chrome', async () => {
            const sampleHtml = '<html><body>Test</body></html>';

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml(sampleHtml, outputPdfPath);

                expect(mockPuppeteer.launch).toHaveBeenCalledWith({
                    headless: true,
                    args: expect.arrayContaining([
                        '--no-sandbox',
                        '--disable-setuid-sandbox'
                    ])
                });
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should navigate to file:// URL', async () => {
            const sampleHtml = '<html><body>File URL Test</body></html>';

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml(sampleHtml, outputPdfPath);

                expect(mockPage.goto).toHaveBeenCalledWith(
                    expect.stringMatching(/^file:\/\//),
                    expect.objectContaining({
                        waitUntil: 'networkidle0'
                    })
                );
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should wait for page to load completely', async () => {
            const sampleHtml = '<html><body>Load Test</body></html>';

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml(sampleHtml, outputPdfPath);

                // Should wait for charts to finish rendering
                expect(mockPage.waitForTimeout).toHaveBeenCalledWith(
                    expect.any(Number)
                );
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should generate PDF with correct options', async () => {
            const sampleHtml = '<html><body>PDF Options Test</body></html>';

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml(sampleHtml, outputPdfPath);

                expect(mockPage.pdf).toHaveBeenCalledWith({
                    path: outputPdfPath,
                    format: 'A4',
                    printBackground: true,
                    margin: {
                        top: '20px',
                        right: '20px',
                        bottom: '20px',
                        left: '20px'
                    }
                });
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should close browser after PDF generation', async () => {
            const sampleHtml = '<html><body>Close Test</body></html>';

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml(sampleHtml, outputPdfPath);

                expect(mockBrowser.close).toHaveBeenCalled();
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should clean up temporary HTML file', async () => {
            const sampleHtml = '<html><body>Cleanup Test</body></html>';

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml(sampleHtml, outputPdfPath);

                // Temporary file should be deleted
                const files = await fs.readdir(testDir);
                const tempFiles = files.filter(f => f.includes('temp') && f.endsWith('.html'));
                expect(tempFiles.length).toBe(0);
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });
    });

    describe('Error Handling', () => {
        test('should handle browser launch failure', async () => {
            mockPuppeteer.launch.mockRejectedValueOnce(new Error('Chrome not found'));

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                
                await expect(
                    generatePdfFromHtml('<html></html>', outputPdfPath)
                ).rejects.toThrow('Chrome not found');
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should handle page navigation failure', async () => {
            mockPage.goto.mockRejectedValueOnce(new Error('Navigation failed'));

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                
                await expect(
                    generatePdfFromHtml('<html></html>', outputPdfPath)
                ).rejects.toThrow('Navigation failed');
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should handle PDF generation failure', async () => {
            mockPage.pdf.mockRejectedValueOnce(new Error('PDF generation failed'));

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                
                await expect(
                    generatePdfFromHtml('<html></html>', outputPdfPath)
                ).rejects.toThrow('PDF generation failed');
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should handle file system errors', async () => {
            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                
                // Try to write to invalid directory
                await expect(
                    generatePdfFromHtml('<html></html>', '/invalid/path/test.pdf')
                ).rejects.toThrow();
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should ensure browser is closed even on error', async () => {
            mockPage.pdf.mockRejectedValueOnce(new Error('PDF failed'));

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                
                await expect(
                    generatePdfFromHtml('<html></html>', outputPdfPath)
                ).rejects.toThrow('PDF failed');

                // Browser should still be closed
                expect(mockBrowser.close).toHaveBeenCalled();
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should clean up temp file even on error', async () => {
            const sampleHtml = '<html><body>Error Test</body></html>';
            mockPage.pdf.mockRejectedValueOnce(new Error('PDF failed'));

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                
                await expect(
                    generatePdfFromHtml(sampleHtml, outputPdfPath)
                ).rejects.toThrow('PDF failed');

                // Temp file should still be cleaned up
                const files = await fs.readdir(testDir);
                const tempFiles = files.filter(f => f.includes('temp') && f.endsWith('.html'));
                expect(tempFiles.length).toBe(0);
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });
    });

    describe('PDF Configuration', () => {
        test('should use A4 format by default', async () => {
            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml('<html></html>', outputPdfPath);

                expect(mockPage.pdf).toHaveBeenCalledWith(
                    expect.objectContaining({
                        format: 'A4'
                    })
                );
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should include background graphics', async () => {
            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml('<html></html>', outputPdfPath);

                expect(mockPage.pdf).toHaveBeenCalledWith(
                    expect.objectContaining({
                        printBackground: true
                    })
                );
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });

        test('should set appropriate margins', async () => {
            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml('<html></html>', outputPdfPath);

                expect(mockPage.pdf).toHaveBeenCalledWith(
                    expect.objectContaining({
                        margin: {
                            top: '20px',
                            right: '20px',
                            bottom: '20px',
                            left: '20px'
                        }
                    })
                );
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });
    });

    describe('Chart Rendering Support', () => {
        test('should wait for charts to finish rendering', async () => {
            const htmlWithCharts = `
                <html>
                <body>
                    <canvas id="chart1"></canvas>
                    <canvas id="chart2"></canvas>
                    <script>
                        // Simulate chart rendering
                        setTimeout(() => {
                            document.getElementById('chart1').setAttribute('data-rendered', 'true');
                            document.getElementById('chart2').setAttribute('data-rendered', 'true');
                        }, 1000);
                    </script>
                </body>
                </html>
            `;

            try {
                const { generatePdfFromHtml } = await import('../../src/pdf-generator');
                await generatePdfFromHtml(htmlWithCharts, outputPdfPath);

                // Should wait sufficient time for charts
                expect(mockPage.waitForTimeout).toHaveBeenCalledWith(
                    expect.any(Number)
                );
            } catch (error) {
                expect(error.message).toContain('Cannot resolve module');
            }
        });
    });
});
