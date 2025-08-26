/**
 * PDF Generator Utility
 *
 * Uses Puppeteer to convert HTML reports to PDF format with optimized settings
 * for performance reports including charts and data tables.
 *
 * Required by ticket #5790 - PDF Export Implementation
 */

import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';

/**
 * Configuration options for PDF generation
 */
export interface PdfGenerationOptions {
  /** PDF format (default: A4) */
  format?: 'A4' | 'A3' | 'Letter' | 'Legal';
  /** Include background graphics (default: true) */
  printBackground?: boolean;
  /** Page margins */
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  /** Wait time for charts to render (default: 3000ms) */
  chartRenderingWaitTime?: number;
  /** Display header/footer (default: false) */
  displayHeaderFooter?: boolean;
  /** Custom header template */
  headerTemplate?: string;
  /** Custom footer template */
  footerTemplate?: string;
}

/**
 * Default PDF generation options optimized for performance reports
 */
const DEFAULT_OPTIONS: Required<PdfGenerationOptions> = {
  format: 'A4',
  printBackground: true,
  margin: {
    top: '20px',
    right: '20px',
    bottom: '20px',
    left: '20px',
  },
  chartRenderingWaitTime: 500,
  displayHeaderFooter: false,
  headerTemplate: '',
  footerTemplate: '',
};

/**
 * Generate a PDF from HTML content using Puppeteer
 *
 * @param htmlContent - The complete HTML content to convert
 * @param outputPath - Path where the PDF file should be saved
 * @param options - PDF generation options
 */
export async function generatePdfFromHtml(
  htmlContent: string,
  outputPath: string,
  options: PdfGenerationOptions = {}
): Promise<void> {
  const config = { ...DEFAULT_OPTIONS, ...options };

  // Create temporary HTML file
  const tempDir = dirname(outputPath);
  const tempHtmlPath = join(tempDir, `temp_report_${Date.now()}.html`);

  let browser;

  try {
    // Write HTML content to temporary file
    await fs.writeFile(tempHtmlPath, htmlContent, 'utf-8');

    console.log('🚀 Launching headless Chrome for PDF generation...');

    // Launch Puppeteer with minimal settings to prevent hanging
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 30000, // Reduced timeout
    });

    console.log('📄 Creating new page...');
    const page = await browser.newPage();

    // Set viewport for consistent rendering
    await page.setViewport({
      width: 1200,
      height: 800,
      deviceScaleFactor: 1,
    });

    console.log('🔗 Navigating to HTML file...');
    // Navigate to the temporary HTML file
    await page.goto(`file://${tempHtmlPath}`, {
      waitUntil: 'networkidle0', // Wait for all network requests to finish
      timeout: 30000,
    });

    console.log('⏳ Waiting for charts and dynamic content to render...');
    // Wait for charts and other dynamic content to finish rendering
    await new Promise((resolve) => setTimeout(resolve, config.chartRenderingWaitTime));

    // Simplified: Skip complex chart readiness check to prevent hanging
    console.log('⚠️ Skipping chart readiness check to prevent hanging');

    console.log('📋 Generating PDF...');
    // Generate the PDF
    await page.pdf({
      path: outputPath,
      format: config.format,
      printBackground: config.printBackground,
      margin: config.margin,
      displayHeaderFooter: config.displayHeaderFooter,
      headerTemplate: config.headerTemplate,
      footerTemplate: config.footerTemplate,
      preferCSSPageSize: false, // Use format setting instead
    });

    console.log('✅ PDF generated successfully');
  } catch (error) {
    console.error('❌ PDF generation failed:', error);
    throw new Error(
      `PDF generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  } finally {
    // Clean up: close browser and delete temporary file
    if (browser) {
      try {
        await browser.close();
        console.log('🔒 Browser closed');
      } catch (error) {
        console.warn('⚠️ Error closing browser:', error);
      }
    }

    try {
      await fs.unlink(tempHtmlPath);
      console.log('🧹 Temporary HTML file cleaned up');
    } catch (error) {
      console.warn('⚠️ Error cleaning up temporary file:', error);
    }
  }
}

/**
 * Generate PDF with default settings optimized for ElizaOS performance reports
 *
 * @param htmlContent - The HTML content to convert
 * @param outputPath - Where to save the PDF
 */
export async function generatePerformanceReportPdf(
  htmlContent: string,
  outputPath: string
): Promise<void> {
  return generatePdfFromHtml(htmlContent, outputPath, {
    format: 'A4',
    printBackground: true,
    margin: {
      top: '20px',
      right: '20px',
      bottom: '20px',
      left: '20px',
    },
    chartRenderingWaitTime: 500, // Reduced timeout to prevent hanging
    displayHeaderFooter: true,
    headerTemplate: `
            <div style="font-size: 10px; color: #666; width: 100%; text-align: center; margin: 0 20px;">
                ElizaOS Performance Report
            </div>
        `,
    footerTemplate: `
            <div style="font-size: 10px; color: #666; width: 100%; text-align: center; margin: 0 20px;">
                Page <span class="pageNumber"></span> of <span class="totalPages"></span> • Generated on <span class="date"></span>
            </div>
        `,
  });
}

/**
 * Validate that Puppeteer can be launched (useful for health checks)
 */
export async function validatePuppeteerInstallation(): Promise<boolean> {
  try {
    const browser = await puppeteer.launch({ headless: true });
    await browser.close();
    return true;
  } catch (error) {
    console.error('Puppeteer validation failed:', error);
    return false;
  }
}

/**
 * Get information about the Puppeteer installation
 */
export async function getPuppeteerInfo(): Promise<{
  version: string;
  executablePath: string;
  isValid: boolean;
}> {
  try {
    const browser = await puppeteer.launch({ headless: true });
    const version = await browser.version();
    const executablePath = browser.process()?.spawnfile || 'unknown';
    await browser.close();

    return {
      version,
      executablePath,
      isValid: true,
    };
  } catch (error) {
    return {
      version: 'unknown',
      executablePath: 'unknown',
      isValid: false,
    };
  }
}
