#!/usr/bin/env node
// monitor_cron_jobs.js - Check health of scheduled cron jobs
// Runs every 10 minutes

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'cron_monitor.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load config:', e.message);
    return { jobs: [], alertThresholdMinutes: 30 };
  }
}

function checkJobHealth(config) {
  const now = Date.now();
  const results = [];

  for (const job of config.jobs) {
    const lastRun = job.lastRunTimestamp || 0;
    const elapsedMin = (now - lastRun) / 60000;
    const healthy = elapsedMin < (job.intervalMinutes * 2);

    results.push({
      name: job.name,
      lastRun: new Date(lastRun).toISOString(),
      elapsedMinutes: Math.round(elapsedMin),
      healthy
    });
  }

  return results;
}

function main() {
  const config = loadConfig();
  const results = checkJobHealth(config);
  const timestamp = new Date().toISOString();

  const logEntry = {
    timestamp,
    checks: results,
    allHealthy: results.every(r => r.healthy)
  };

  const logFile = path.join(LOG_DIR, 'cron_monitor.log');
  fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');

  if (!logEntry.allHealthy) {
    const unhealthy = results.filter(r => !r.healthy);
    console.warn(`[${timestamp}] Unhealthy jobs:`, unhealthy.map(r => r.name).join(', '));
  }
}

main();
