import { describe, it, expect, beforeAll } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse } from 'node-html-parser';

describe('HTML Report Template', () => {
  let templateContent: string;
  let parsedHtml: any;

  beforeAll(async () => {
    const templatePath = join(__dirname, '..', 'assets', 'report_template.html');
    templateContent = await readFile(templatePath, 'utf-8');
    parsedHtml = parse(templateContent);
  });

  describe('File Structure and Validation', () => {
    it('should be a valid HTML document', () => {
      expect(templateContent).toBeTruthy();
      expect(parsedHtml.querySelector('html')).toBeTruthy();
      expect(parsedHtml.querySelector('head')).toBeTruthy();
      expect(parsedHtml.querySelector('body')).toBeTruthy();
    });

    it('should have embedded CSS in style tag', () => {
      const styleTag = parsedHtml.querySelector('style');
      expect(styleTag).toBeTruthy();
      expect(styleTag.innerHTML.length).toBeGreaterThan(100); // Should have substantial CSS
    });

    it('should have embedded Chart.js library', () => {
      const chartScript = parsedHtml
        .querySelectorAll('script')
        .find(
          (script: any) => script.innerHTML.includes('Chart') || script.innerHTML.includes('chart')
        );
      expect(chartScript).toBeTruthy();
    });

    it('should not have external network requests', () => {
      // Check for external links, scripts, or stylesheets
      const externalLinks = parsedHtml.querySelectorAll('link[href^="http"]');
      const externalScripts = parsedHtml.querySelectorAll('script[src^="http"]');

      expect(externalLinks.length).toBe(0);
      expect(externalScripts.length).toBe(0);
    });
  });

  describe('Report Structure and Layout', () => {
    it('should have report header section', () => {
      const header = parsedHtml.querySelector('#report-header, .report-header, h1');
      expect(header).toBeTruthy();
    });

    it('should have high-level summary section', () => {
      const summary = parsedHtml.querySelector('#summary-section, .summary-section, #summary');
      expect(summary).toBeTruthy();
    });

    it('should have results by parameter section', () => {
      const parameterResults = parsedHtml.querySelector(
        '#parameter-results, .parameter-results, #results-by-parameter'
      );
      expect(parameterResults).toBeTruthy();
    });

    it('should have capability analysis section', () => {
      const capabilities = parsedHtml.querySelector(
        '#capability-analysis, .capability-analysis, #capabilities'
      );
      expect(capabilities).toBeTruthy();
    });

    it('should have trajectory analysis section', () => {
      const trajectories = parsedHtml.querySelector(
        '#trajectory-analysis, .trajectory-analysis, #trajectories'
      );
      expect(trajectories).toBeTruthy();
    });

    it('should have detailed run explorer section', () => {
      const runExplorer = parsedHtml.querySelector('#run-explorer, .run-explorer, #detailed-runs');
      expect(runExplorer).toBeTruthy();
    });
  });

  describe('Component Placeholders', () => {
    it('should have placeholder for total runs', () => {
      const totalRuns = parsedHtml.querySelector('#summary-total-runs, #total-runs');
      expect(totalRuns).toBeTruthy();
    });

    it('should have placeholder for overall success rate', () => {
      const successRate = parsedHtml.querySelector(
        '#summary-success-rate, #success-rate, #overall-success-rate'
      );
      expect(successRate).toBeTruthy();
    });

    it('should have placeholder for average execution time', () => {
      const avgTime = parsedHtml.querySelector(
        '#summary-avg-time, #average-execution-time, #avg-execution-time'
      );
      expect(avgTime).toBeTruthy();
    });

    it('should have canvas elements for charts', () => {
      const canvasElements = parsedHtml.querySelectorAll('canvas');
      expect(canvasElements.length).toBeGreaterThan(0);

      // Check that each canvas has an ID
      canvasElements.forEach((canvas: any) => {
        expect(canvas.getAttribute('id')).toBeTruthy();
      });
    });

    it('should have table body for detailed runs', () => {
      const tableBody = parsedHtml.querySelector('#detailed-runs-tbody, #runs-table-body, tbody');
      expect(tableBody).toBeTruthy();
    });

    it('should have data island for JSON data', () => {
      const dataIsland = parsedHtml.querySelector(
        'script[id="report-data"][type="application/json"]'
      );
      expect(dataIsland).toBeTruthy();
    });
  });

  describe('JavaScript Integration', () => {
    it('should have renderReport function defined', () => {
      const renderScript = parsedHtml
        .querySelectorAll('script')
        .find((script: any) => script.innerHTML.includes('renderReport'));
      expect(renderScript).toBeTruthy();
    });

    it('should have function to handle data injection', () => {
      const scripts = parsedHtml.querySelectorAll('script');
      const hasDataHandling = scripts.some(
        (script: any) =>
          script.innerHTML.includes('getElementById') || script.innerHTML.includes('querySelector')
      );
      expect(hasDataHandling).toBeTruthy();
    });
  });

  describe('Responsive Design', () => {
    it('should have viewport meta tag', () => {
      const viewport = parsedHtml.querySelector('meta[name="viewport"]');
      expect(viewport).toBeTruthy();
      expect(viewport.getAttribute('content')).toContain('width=device-width');
    });

    it('should have responsive CSS rules', () => {
      const styleTag = parsedHtml.querySelector('style');
      const css = styleTag.innerHTML;

      // Check for common responsive patterns
      const hasMediaQueries =
        css.includes('@media') || css.includes('max-width') || css.includes('min-width');
      const hasFlexbox = css.includes('display: flex') || css.includes('display:flex');
      const hasGrid = css.includes('display: grid') || css.includes('display:grid');

      expect(hasMediaQueries || hasFlexbox || hasGrid).toBeTruthy();
    });
  });

  describe('Accessibility and Best Practices', () => {
    it('should have proper document title', () => {
      const title = parsedHtml.querySelector('title');
      expect(title).toBeTruthy();
      expect(title.innerHTML.length).toBeGreaterThan(0);
    });

    it('should have semantic HTML structure', () => {
      const main = parsedHtml.querySelector('main');
      const sections = parsedHtml.querySelectorAll('section, article, div[role]');

      expect(main || sections.length > 0).toBeTruthy();
    });

    it('should have appropriate color contrast indicators', () => {
      const styleTag = parsedHtml.querySelector('style');
      const css = styleTag.innerHTML;

      // Look for success/failure color patterns
      const hasGreen = css.includes('green') || css.includes('#0') || css.includes('rgb(');
      const hasRed = css.includes('red') || css.includes('#f') || css.includes('rgb(');

      expect(hasGreen || hasRed).toBeTruthy();
    });
  });
});
