#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Generate filename with timestamp
const timestamp = new Date().toISOString().replace(/:/g, '-');
const mainLogFile = path.join(logsDir, `scalability-analysis-${timestamp}.log`);

// Create a header for the main log file
fs.writeFileSync(
  mainLogFile,
  `AGENT SCALABILITY ANALYSIS\n` +
  `=======================\n` +
  `Started: ${new Date().toISOString()}\n\n` +
  `This test suite runs progressively larger load tests to identify breaking points:\n` +
  `- 2 agents (baseline)\n` +
  `- 5 agents (small group)\n` +
  `- 10 agents (medium group)\n` +
  `- 50 agents (large group)\n` +
  `- 100 agents (very large group)\n` +
  `- 250 agents (mass scale)\n` +
  `- 500 agents (extreme scale)\n` +
  `- 1000 agents (maximum load)\n` +
  `- 2000 agents (breaking point test)\n\n` +
  `OBJECTIVE: Identify thresholds and optimize for scalability\n\n` +
  `TESTING LOG:\n` +
  `===========\n\n`
);

console.log('Starting Agent Scalability Analysis');
console.log(`Log file: ${mainLogFile}`);
console.log('-------------------------------------');

try {
  // Run the tests with increased timeout (10 minutes)
  console.log('Running load tests to find breaking points...');
  
  // Execute the test and pipe output to both console and file
  const testProcess = execSync(
    'NODE_OPTIONS="--max-old-space-size=4096" bun test --timeout 600000 packages/the-org/src/loadTest/__tests__/scale.test.ts', 
    { 
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  
  // Write output to log file and display in console
  fs.appendFileSync(mainLogFile, testProcess);
  console.log(testProcess);
  
  // Parse results to find breaking points
  const summaryFiles = fs.readdirSync(logsDir).filter(f => f.startsWith('load-test-summary-'));
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
      fs.appendFileSync(
        mainLogFile,
        `\n\nSCALABILITY CONCLUSIONS\n` +
        `======================\n\n` +
        conclusions + '\n\n' +
        `For detailed metrics on each test configuration, see the individual test logs.\n`
      );
    }
  }
  
  // Add visualization hint
  fs.appendFileSync(
    mainLogFile,
    `\n\nVISUALIZATION\n` +
    `=============\n` +
    `To visualize the scalability results, you can plot the following metrics:\n` +
    `1. Success Rate vs. Agent Count\n` +
    `2. Response Time vs. Agent Count\n` +
    `3. Throughput vs. Agent Count\n` +
    `4. Error Rate vs. Agent Count\n\n` +
    `The optimal configuration is typically just before the breaking point where:\n` +
    `- Success rate is still high (>95%)\n` +
    `- Response times remain reasonable (<1000ms)\n` +
    `- Throughput is maximized\n\n` +
    `Test completed at: ${new Date().toISOString()}\n` +
    `=================\n\n`
  );
  
  console.log(`\nScalability analysis complete. Full report saved to: ${mainLogFile}`);
  console.log('Check the logs directory for detailed test results for each configuration.');
} catch (error) {
  // If tests fail, still save the output and error
  fs.appendFileSync(
    mainLogFile, 
    `\n\nERROR DURING TESTING:\n` +
    `===================\n` +
    `${error.stdout || ''}\n` +
    `${error.stderr || ''}\n` +
    `${error.message}\n\n` +
    `Even though an error occurred, this might represent the actual breaking point.\n` +
    `Examine the logs to determine the last successful configuration.\n\n` +
    `Test failed at: ${new Date().toISOString()}\n`
  );
  
  console.error('Tests encountered errors, which may indicate the breaking point was reached.');
  console.error('Check the error details in the log file.');
  console.error(error.stdout || '');
  console.error(error.stderr || '');
  process.exit(1);
} 