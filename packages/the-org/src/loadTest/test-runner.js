#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@elizaos/core';
import utils from './utils.js';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory if it doesn't exist
const logsDir = utils.ensureLogsDirectory();

// Generate filename with timestamp
const timestamp = utils.generateTimestamp();
const mainLogFile = path.join(logsDir, `scalability-analysis-${timestamp}.log`);

// Create a header for the main log file
fs.writeFileSync(mainLogFile, utils.createScalabilityAnalysisHeader());

logger.info('Starting Agent Scalability Analysis');
logger.info(`Log file: ${mainLogFile}`);
logger.info('-------------------------------------');

try {
  // Run the tests with increased timeout (10 minutes)
  logger.info('Running load tests to find breaking points...');

  // Execute the test and pipe output to both console and file
  const testProcess = execSync(
    'NODE_OPTIONS="--max-old-space-size=4096" bun test --timeout 600000 packages/the-org/src/loadTest/__tests__/scale.test.ts',
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  // Write output to log file and display in console
  fs.appendFileSync(mainLogFile, testProcess);
  console.log(testProcess);

  // Parse results to find breaking points
  const summaryFiles = fs.readdirSync(logsDir).filter((f) => f.startsWith('load-test-summary-'));
  if (summaryFiles.length > 0) {
    // Get most recent summary file
    const latestSummary = summaryFiles.sort().pop();
    const summaryContent = fs.readFileSync(path.join(logsDir, latestSummary), 'utf8');

    // Extract conclusions
    let conclusions = '';
    if (summaryContent.includes('SCALABILITY ANALYSIS')) {
      const analysisSection = summaryContent.split('SCALABILITY ANALYSIS')[1];
      conclusions = analysisSection.split('====================')[0].trim();
    }

    if (conclusions) {
      // Add summary to main log file
      fs.appendFileSync(mainLogFile, utils.formatScalabilityConclusions(conclusions));
    }
  }

  // Add visualization hint
  fs.appendFileSync(mainLogFile, utils.formatVisualizationGuide());

  logger.info(`\nScalability analysis complete. Full report saved to: ${mainLogFile}`);
  logger.info('Check the logs directory for detailed test results for each configuration.');
} catch (error) {
  // If tests fail, still save the output and error
  fs.appendFileSync(mainLogFile, utils.formatErrorMessage(error));

  logger.error('Tests encountered errors, which may indicate the breaking point was reached.');
  logger.error('Check the error details in the log file.');
  logger.error(error.stdout || '');
  logger.error(error.stderr || '');
  process.exit(1);
}
