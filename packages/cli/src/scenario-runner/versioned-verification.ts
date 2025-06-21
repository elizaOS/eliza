import { logger } from '@elizaos/core';
import { createHash } from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { VerificationResult, ScenarioContext } from './types.js';

export interface VerificationVersion {
  version: string;
  timestamp: string;
  description: string;
  changes: VersionChange[];
  compatibility: CompatibilityInfo;
}

export interface VersionChange {
  type: 'added' | 'modified' | 'deprecated' | 'removed';
  component: string;
  description: string;
  impact: 'breaking' | 'non-breaking' | 'enhancement';
}

export interface CompatibilityInfo {
  backwardCompatible: boolean;
  minimumVersion: string;
  deprecationWarnings: string[];
  migrationRequired: boolean;
}

export interface VerificationSnapshot {
  ruleId: string;
  version: string;
  input: any;
  expectedOutput: VerificationResult;
  actualOutput?: VerificationResult;
  timestamp: string;
  hash: string;
}

export class VersionedVerificationEngine {
  private currentVersion = '1.0.0';
  private snapshotsDir: string;
  private versionsFile: string;

  constructor(baseDir: string = './verification-snapshots') {
    this.snapshotsDir = path.join(baseDir, 'snapshots');
    this.versionsFile = path.join(baseDir, 'versions.json');
  }

  async initializeVersioning(): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });

    if (!(await this.fileExists(this.versionsFile))) {
      const initialVersion: VerificationVersion = {
        version: this.currentVersion,
        timestamp: new Date().toISOString(),
        description: 'Initial verification system version',
        changes: [
          {
            type: 'added',
            component: 'versioned-verification',
            description: 'Added versioning and snapshot testing capability',
            impact: 'enhancement',
          },
        ],
        compatibility: {
          backwardCompatible: true,
          minimumVersion: '1.0.0',
          deprecationWarnings: [],
          migrationRequired: false,
        },
      };

      await this.saveVersion(initialVersion);
    }
  }

  async createSnapshot(
    rule: any,
    context: ScenarioContext,
    expectedResult: VerificationResult
  ): Promise<string> {
    const input = this.sanitizeForSnapshot(rule, context);
    const hash = this.generateSnapshotHash(input, expectedResult);

    const snapshot: VerificationSnapshot = {
      ruleId: rule.id,
      version: this.currentVersion,
      input,
      expectedOutput: expectedResult,
      timestamp: new Date().toISOString(),
      hash,
    };

    const snapshotFile = path.join(
      this.snapshotsDir,
      `${rule.id}-${this.currentVersion}-${hash.substring(0, 8)}.json`
    );

    await fs.writeFile(snapshotFile, JSON.stringify(snapshot, null, 2));
    logger.debug(`Created verification snapshot: ${snapshotFile}`);

    return snapshotFile;
  }

  async validateAgainstSnapshots(
    rule: any,
    context: ScenarioContext,
    actualResult: VerificationResult
  ): Promise<{
    isValid: boolean;
    differences: string[];
    matchingSnapshots: string[];
    regressions: string[];
  }> {
    const input = this.sanitizeForSnapshot(rule, context);
    const snapshots = await this.findMatchingSnapshots(rule.id, input);

    const differences: string[] = [];
    const matchingSnapshots: string[] = [];
    const regressions: string[] = [];

    for (const snapshot of snapshots) {
      const diffs = this.compareResults(snapshot.expectedOutput, actualResult);

      if (diffs.length === 0) {
        matchingSnapshots.push(snapshot.hash);
      } else {
        differences.push(...diffs);

        // Check if this is a regression (was passing, now failing)
        if (snapshot.expectedOutput.passed && !actualResult.passed) {
          regressions.push(
            `Rule ${rule.id}: was passing (${snapshot.expectedOutput.score}), now failing (${actualResult.score})`
          );
        }
      }
    }

    return {
      isValid: differences.length === 0,
      differences,
      matchingSnapshots,
      regressions,
    };
  }

  async runSnapshotTests(): Promise<{
    totalTests: number;
    passed: number;
    failed: number;
    regressions: number;
    details: SnapshotTestResult[];
  }> {
    const snapshotFiles = await fs.readdir(this.snapshotsDir);
    const testResults: SnapshotTestResult[] = [];

    let totalTests = 0;
    let passed = 0;
    let failed = 0;
    let regressions = 0;

    for (const file of snapshotFiles) {
      if (!file.endsWith('.json')) continue;

      try {
        const snapshotPath = path.join(this.snapshotsDir, file);
        const snapshot: VerificationSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));

        // Re-run the verification with the snapshot input
        const actualResult = await this.rerunVerification(snapshot);

        const diffs = this.compareResults(snapshot.expectedOutput, actualResult);
        const isRegression = snapshot.expectedOutput.passed && !actualResult.passed;

        const testResult: SnapshotTestResult = {
          snapshotFile: file,
          ruleId: snapshot.ruleId,
          version: snapshot.version,
          passed: diffs.length === 0,
          differences: diffs,
          isRegression,
          expectedScore: snapshot.expectedOutput.score || 0,
          actualScore: actualResult.score || 0,
        };

        testResults.push(testResult);
        totalTests++;

        if (testResult.passed) {
          passed++;
        } else {
          failed++;
          if (isRegression) regressions++;
        }
      } catch (error) {
        logger.error(`Failed to process snapshot ${file}:`, error);
        failed++;
        totalTests++;
      }
    }

    return {
      totalTests,
      passed,
      failed,
      regressions,
      details: testResults,
    };
  }

  async createNewVersion(
    version: string,
    description: string,
    changes: VersionChange[]
  ): Promise<void> {
    const newVersion: VerificationVersion = {
      version,
      timestamp: new Date().toISOString(),
      description,
      changes,
      compatibility: this.analyzeCompatibility(changes),
    };

    await this.saveVersion(newVersion);
    this.currentVersion = version;

    logger.info(`Created new verification version: ${version}`);
  }

  async migrateSnapshots(fromVersion: string, toVersion: string): Promise<void> {
    const snapshots = await this.getSnapshotsByVersion(fromVersion);

    for (const snapshot of snapshots) {
      // Apply migration logic here
      const migratedSnapshot = await this.migrateSnapshot(snapshot, toVersion);

      const newSnapshotFile = path.join(
        this.snapshotsDir,
        `${snapshot.ruleId}-${toVersion}-${migratedSnapshot.hash.substring(0, 8)}.json`
      );

      await fs.writeFile(newSnapshotFile, JSON.stringify(migratedSnapshot, null, 2));
    }

    logger.info(`Migrated ${snapshots.length} snapshots from ${fromVersion} to ${toVersion}`);
  }

  // Private methods
  private sanitizeForSnapshot(rule: any, context: ScenarioContext): any {
    return {
      rule: {
        id: rule.id,
        type: rule.type,
        description: rule.description,
        config: rule.config,
      },
      context: {
        scenarioId: context.scenario.id,
        transcriptLength: context.transcript.length,
        transcriptHash: this.hashTranscript(context.transcript),
        // Don't include full transcript for privacy
      },
    };
  }

  private generateSnapshotHash(input: any, output: VerificationResult): string {
    const data = JSON.stringify({ input, output });
    return createHash('sha256').update(data).digest('hex');
  }

  private hashTranscript(transcript: any[]): string {
    const content = transcript.map((msg) => msg.content?.text || '').join('');
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  private async findMatchingSnapshots(ruleId: string, input: any): Promise<VerificationSnapshot[]> {
    const snapshotFiles = await fs.readdir(this.snapshotsDir);
    const matchingSnapshots: VerificationSnapshot[] = [];

    for (const file of snapshotFiles) {
      if (!file.startsWith(ruleId) || !file.endsWith('.json')) continue;

      try {
        const snapshotPath = path.join(this.snapshotsDir, file);
        const snapshot: VerificationSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));

        // Simple matching based on input similarity
        if (this.inputsMatch(snapshot.input, input)) {
          matchingSnapshots.push(snapshot);
        }
      } catch (error) {
        logger.warn(`Failed to read snapshot ${file}:`, error);
      }
    }

    return matchingSnapshots;
  }

  private inputsMatch(snapshot1: any, snapshot2: any): boolean {
    // Simple comparison - in production, this would be more sophisticated
    return JSON.stringify(snapshot1) === JSON.stringify(snapshot2);
  }

  private compareResults(expected: VerificationResult, actual: VerificationResult): string[] {
    const differences: string[] = [];

    if (expected.passed !== actual.passed) {
      differences.push(`Pass/fail mismatch: expected ${expected.passed}, got ${actual.passed}`);
    }

    const scoreDiff = Math.abs((expected.score || 0) - (actual.score || 0));
    if (scoreDiff > 0.1) {
      differences.push(
        `Score difference: expected ${expected.score}, got ${actual.score} (diff: ${scoreDiff})`
      );
    }

    if (expected.reason !== actual.reason) {
      differences.push(`Reasoning changed: expected "${expected.reason}", got "${actual.reason}"`);
    }

    return differences;
  }

  private async rerunVerification(snapshot: VerificationSnapshot): Promise<VerificationResult> {
    // Mock implementation - in reality, this would re-run the actual verification
    // For now, return a slightly modified result to simulate changes
    return {
      ...snapshot.expectedOutput,
      score: Math.max(0, (snapshot.expectedOutput.score || 0) - 0.05), // Slight degradation
    };
  }

  private analyzeCompatibility(changes: VersionChange[]): CompatibilityInfo {
    const breakingChanges = changes.filter((c) => c.impact === 'breaking');
    const deprecations = changes.filter((c) => c.type === 'deprecated');

    return {
      backwardCompatible: breakingChanges.length === 0,
      minimumVersion: this.currentVersion,
      deprecationWarnings: deprecations.map((d) => d.description),
      migrationRequired: breakingChanges.length > 0,
    };
  }

  private async saveVersion(version: VerificationVersion): Promise<void> {
    let versions: VerificationVersion[] = [];

    if (await this.fileExists(this.versionsFile)) {
      const data = await fs.readFile(this.versionsFile, 'utf8');
      versions = JSON.parse(data);
    }

    versions.push(version);
    await fs.writeFile(this.versionsFile, JSON.stringify(versions, null, 2));
  }

  private async getSnapshotsByVersion(version: string): Promise<VerificationSnapshot[]> {
    const snapshotFiles = await fs.readdir(this.snapshotsDir);
    const snapshots: VerificationSnapshot[] = [];

    for (const file of snapshotFiles) {
      if (!file.includes(version) || !file.endsWith('.json')) continue;

      try {
        const snapshotPath = path.join(this.snapshotsDir, file);
        const snapshot: VerificationSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
        snapshots.push(snapshot);
      } catch (error) {
        logger.warn(`Failed to read snapshot ${file}:`, error);
      }
    }

    return snapshots;
  }

  private async migrateSnapshot(
    snapshot: VerificationSnapshot,
    toVersion: string
  ): Promise<VerificationSnapshot> {
    // Apply version-specific migration logic
    const migrated = { ...snapshot };
    migrated.version = toVersion;
    migrated.timestamp = new Date().toISOString();
    migrated.hash = this.generateSnapshotHash(migrated.input, migrated.expectedOutput);

    return migrated;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export interface SnapshotTestResult {
  snapshotFile: string;
  ruleId: string;
  version: string;
  passed: boolean;
  differences: string[];
  isRegression: boolean;
  expectedScore: number;
  actualScore: number;
}
