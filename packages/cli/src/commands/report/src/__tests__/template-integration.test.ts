import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('HTML Template Integration', () => {
  let templatePath: string;
  let tempReportPath: string;

  beforeAll(async () => {
    templatePath = join(__dirname, '..', 'assets', 'report_template.html');
    tempReportPath = join(tmpdir(), `test-report-${Date.now()}.html`);
  });

  afterAll(async () => {
    try {
      await unlink(tempReportPath);
    } catch (error) {
      // File might not exist, ignore error
    }
  });

  describe('Data Injection and Rendering', () => {
    it('should successfully inject report data into template', async () => {
      // Read the template
      const templateContent = await readFile(templatePath, 'utf-8');

      // Sample report data (similar to what our AnalysisEngine produces)
      const sampleReportData = {
        metadata: {
          report_generated_at: '2025-01-17T12:00:00.000Z',
          matrix_config: {
            name: 'Test Matrix',
            description: 'Integration test matrix',
            base_scenario: 'test.scenario.yaml',
            runs_per_combination: 1,
            matrix: [],
          },
          input_directory: '/test/input',
          processed_files: 3,
          skipped_files: 0,
        },
        summary_stats: {
          total_runs: 3,
          total_failed_runs: 0,
          average_execution_time: 42.5,
          median_execution_time: 40.0,
          average_llm_calls: 2,
          average_total_tokens: 750,
          capability_success_rates: {
            'List GitHub Issues': 1.0,
            'Format Response': 0.85,
          },
          overall_success_rate: 0.92,
        },
        results_by_parameter: {
          model: {
            'gpt-4': {
              total_runs: 2,
              total_failed_runs: 0,
              average_execution_time: 45.0,
              median_execution_time: 45.0,
              average_llm_calls: 2,
              average_total_tokens: 800,
              capability_success_rates: {
                'List GitHub Issues': 1.0,
              },
              overall_success_rate: 1.0,
            },
            'gpt-3.5-turbo': {
              total_runs: 1,
              total_failed_runs: 0,
              average_execution_time: 37.5,
              median_execution_time: 37.5,
              average_llm_calls: 2,
              average_total_tokens: 650,
              capability_success_rates: {
                'Format Response': 0.7,
              },
              overall_success_rate: 0.8,
            },
          },
        },
        common_trajectories: [
          {
            sequence: ['thought', 'action', 'observation'],
            count: 3,
            average_duration: 42.5,
            percentage: 1.0,
          },
          {
            sequence: ['thought', 'action', 'action', 'observation'],
            count: 1,
            average_duration: 50.0,
            percentage: 0.33,
          },
        ],
        raw_results: [
          {
            run_id: 'test-run-1',
            matrix_combination_id: 'combo-1',
            parameters: {
              model: 'gpt-4',
              temperature: 0.7,
            },
            metrics: {
              execution_time_seconds: 45.0,
              llm_calls: 2,
              total_tokens: 800,
            },
            final_agent_response: 'Test response 1',
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
                content: 'I need to process this request',
              },
              {
                type: 'action',
                timestamp: '2025-01-17T12:00:01.000Z',
                content: { name: 'TEST_ACTION', parameters: {} },
              },
              {
                type: 'observation',
                timestamp: '2025-01-17T12:00:02.000Z',
                content: 'Action completed successfully',
              },
            ],
            error: null,
          },
        ],
      };

      // Inject data into template
      const reportHtml = templateContent.replace(
        '<script id="report-data" type="application/json">\n        {}\n    </script>',
        `<script id="report-data" type="application/json">\n        ${JSON.stringify(sampleReportData, null, 2)}\n    </script>`
      );

      // Write the populated template to temp file
      await writeFile(tempReportPath, reportHtml, 'utf-8');

      // Verify the file was created and contains the data
      const writtenContent = await readFile(tempReportPath, 'utf-8');

      expect(writtenContent).toContain('Test Matrix');
      expect(writtenContent).toContain('test-run-1');
      expect(writtenContent).toContain('"total_runs": 3');
      expect(writtenContent).toContain('List GitHub Issues');
    });

    it('should have all required placeholders for dynamic content', async () => {
      const templateContent = await readFile(templatePath, 'utf-8');

      // Check for all the key placeholders mentioned in the ticket
      const requiredPlaceholders = [
        '#report-date',
        '#matrix-name',
        '#total-files',
        '#summary-total-runs',
        '#summary-success-rate',
        '#summary-avg-time',
        '#summary-avg-tokens',
        '#capability-chart',
        '#parameter-chart',
        '#trajectory-chart',
        '#detailed-runs-tbody',
        'script[id="report-data"]',
      ];

      requiredPlaceholders.forEach((placeholder) => {
        if (placeholder.startsWith('#')) {
          expect(templateContent).toContain(`id="${placeholder.slice(1)}"`);
        } else if (placeholder === 'script[id="report-data"]') {
          expect(templateContent).toContain('<script id="report-data" type="application/json">');
        } else {
          expect(templateContent).toContain(placeholder);
        }
      });
    });

    it('should have renderReport function that handles all data sections', async () => {
      const templateContent = await readFile(templatePath, 'utf-8');

      // Verify the main render function exists
      expect(templateContent).toContain('function renderReport(data)');

      // Verify it calls all the sub-rendering functions
      const expectedFunctionCalls = [
        'renderReportHeader(data.metadata)',
        'renderSummaryStats(data.summary_stats)',
        'renderCapabilityAnalysis(data.summary_stats.capability_success_rates)',
        'renderParameterResults(data.results_by_parameter)',
        'renderTrajectoryAnalysis(data.common_trajectories)',
        'renderDetailedRuns(data.raw_results)',
      ];

      expectedFunctionCalls.forEach((functionCall) => {
        expect(templateContent).toContain(functionCall);
      });
    });

    it('should handle empty or missing data gracefully', async () => {
      const templateContent = await readFile(templatePath, 'utf-8');

      // Check for defensive programming patterns
      expect(templateContent).toContain('No capability-based evaluators found');
      expect(templateContent).toContain('No parameter variations found');
      expect(templateContent).toContain('No trajectory patterns found');
      expect(templateContent).toContain('No run data available');

      // Check for error handling
      expect(templateContent).toContain('try {');
      expect(templateContent).toContain('catch (error)');
      expect(templateContent).toContain('showError');
    });
  });

  describe('Chart Integration', () => {
    it('should have placeholder chart rendering functions', async () => {
      const templateContent = await readFile(templatePath, 'utf-8');

      const chartFunctions = [
        'renderCapabilityChart',
        'renderParameterChart',
        'renderTrajectoryChart',
      ];

      chartFunctions.forEach((func) => {
        expect(templateContent).toContain(`function ${func}`);
      });
    });

    it('should have canvas elements with proper dimensions', async () => {
      const templateContent = await readFile(templatePath, 'utf-8');

      // Check for canvas elements with width/height
      expect(templateContent).toContain('width="800" height="400"');
      expect(templateContent).toContain('canvas id="capability-chart"');
      expect(templateContent).toContain('canvas id="parameter-chart"');
      expect(templateContent).toContain('canvas id="trajectory-chart"');
    });
  });

  describe('Self-Contained Validation', () => {
    it('should not reference external resources', async () => {
      const templateContent = await readFile(templatePath, 'utf-8');

      // Should not have external links
      expect(templateContent).not.toContain('href="http');
      expect(templateContent).not.toContain('src="http');
      expect(templateContent).not.toContain('cdn.');
      expect(templateContent).not.toContain('@import url');
    });

    it('should have embedded Chart.js library', async () => {
      const templateContent = await readFile(templatePath, 'utf-8');

      // Should contain Chart.js code embedded
      expect(templateContent).toContain('Chart.js');
      expect(templateContent).toContain('window.Chart');
    });

    it('should have complete CSS styling embedded', async () => {
      const templateContent = await readFile(templatePath, 'utf-8');

      // Should have substantial CSS
      const cssMatch = templateContent.match(/<style>([\s\S]*?)<\/style>/);
      expect(cssMatch).toBeTruthy();
      expect(cssMatch?.[1].length).toBeGreaterThan(1000); // Should have substantial CSS

      // Should have key CSS classes
      expect(templateContent).toContain('.summary-grid');
      expect(templateContent).toContain('.chart-container');
      expect(templateContent).toContain('.parameter-group');
      expect(templateContent).toContain('@media'); // Responsive design
    });
  });
});
