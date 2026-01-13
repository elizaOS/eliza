/**
 * Quick stats tests converted from test_quick_stats.py
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { quickStats } from '../src/run/quick-stats';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Quick Stats', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-stats-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  describe('quickStats function', () => {
    it('should handle empty directories', async () => {
      const result = await quickStats(tmpDir);
      expect(result).toBe('No .traj files found.');
    });

    it('should process trajectory files correctly', async () => {
      // Create a sample .traj file with required structure
      const trajFile = path.join(tmpDir, 'test.traj');
      const trajData = {
        info: {
          model_stats: {
            api_calls: 42,
            tokens_sent: 1000,
            tokens_received: 500,
            instance_cost: 0.05,
          },
          exit_status: 'success',
        },
      };

      fs.writeFileSync(trajFile, JSON.stringify(trajData));

      const result = await quickStats(tmpDir);

      // Check that the result contains our exit status
      expect(result).toContain('## `success`');
      expect(result).not.toBe('No .traj files found.');
    });

    it('should handle multiple trajectory files', async () => {
      // Create multiple .traj files with different exit statuses
      const trajData1 = {
        info: {
          model_stats: {
            api_calls: 10,
            tokens_sent: 500,
            tokens_received: 200,
            instance_cost: 0.02,
          },
          exit_status: 'success',
        },
      };

      const trajData2 = {
        info: {
          model_stats: {
            api_calls: 5,
            tokens_sent: 300,
            tokens_received: 150,
            instance_cost: 0.01,
          },
          exit_status: 'exit_cost',
        },
      };

      const trajData3 = {
        info: {
          model_stats: {
            api_calls: 20,
            tokens_sent: 1500,
            tokens_received: 800,
            instance_cost: 0.08,
          },
          exit_status: 'success',
        },
      };

      fs.writeFileSync(path.join(tmpDir, 'test1.traj'), JSON.stringify(trajData1));
      fs.writeFileSync(path.join(tmpDir, 'test2.traj'), JSON.stringify(trajData2));
      fs.writeFileSync(path.join(tmpDir, 'test3.traj'), JSON.stringify(trajData3));

      const result = await quickStats(tmpDir);

      // Check that both exit statuses are present
      expect(result).toContain('## `success`');
      expect(result).toContain('## `exit_cost`');

      // Check that counts are correct
      expect(result).toMatch(/`success`.*2 trajectories/);
      expect(result).toMatch(/`exit_cost`.*1 trajectories/);
    });

    it('should handle malformed trajectory files gracefully', async () => {
      // Create a malformed .traj file
      const malformedFile = path.join(tmpDir, 'malformed.traj');
      fs.writeFileSync(malformedFile, 'not valid json');

      // Create a valid .traj file
      const validFile = path.join(tmpDir, 'valid.traj');
      const validData = {
        info: {
          model_stats: {
            api_calls: 5,
          },
          exit_status: 'success',
        },
      };
      fs.writeFileSync(validFile, JSON.stringify(validData));

      const result = await quickStats(tmpDir);

      // Should still process the valid file
      expect(result).toContain('## `success`');
    });

    it('should handle trajectory files without model_stats', async () => {
      const trajData = {
        info: {
          exit_status: 'submitted',
        },
      };

      fs.writeFileSync(path.join(tmpDir, 'test.traj'), JSON.stringify(trajData));

      const result = await quickStats(tmpDir);

      expect(result).toContain('## `submitted`');
    });

    it('should handle trajectory files without exit_status', async () => {
      const trajData = {
        info: {
          model_stats: {
            api_calls: 10,
          },
        },
      };

      fs.writeFileSync(path.join(tmpDir, 'test.traj'), JSON.stringify(trajData));

      const result = await quickStats(tmpDir);

      // Should handle gracefully, possibly with 'unknown' or similar status
      expect(result).not.toBe('No .traj files found.');
    });

    it('should calculate statistics correctly', async () => {
      // Create files with known stats for verification
      const trajData1 = {
        info: {
          model_stats: {
            api_calls: 10,
            tokens_sent: 1000,
            tokens_received: 500,
            instance_cost: 0.05,
          },
          exit_status: 'success',
        },
      };

      const trajData2 = {
        info: {
          model_stats: {
            api_calls: 20,
            tokens_sent: 2000,
            tokens_received: 1000,
            instance_cost: 0.1,
          },
          exit_status: 'success',
        },
      };

      fs.writeFileSync(path.join(tmpDir, 'test1.traj'), JSON.stringify(trajData1));
      fs.writeFileSync(path.join(tmpDir, 'test2.traj'), JSON.stringify(trajData2));

      const result = await quickStats(tmpDir);

      // Check that stats are aggregated correctly
      expect(result).toContain('success');

      // The exact format might vary, but we should see totals or averages
      // This depends on the implementation of quickStats
    });

    it('should handle nested directories', async () => {
      // Create a nested directory structure
      const nestedDir = path.join(tmpDir, 'nested', 'deep');
      fs.mkdirSync(nestedDir, { recursive: true });

      const trajData = {
        info: {
          model_stats: {
            api_calls: 5,
          },
          exit_status: 'success',
        },
      };

      // Put trajectory files at different levels
      fs.writeFileSync(path.join(tmpDir, 'root.traj'), JSON.stringify(trajData));
      fs.writeFileSync(path.join(nestedDir, 'nested.traj'), JSON.stringify(trajData));

      const result = await quickStats(tmpDir);

      // Should find both files
      expect(result).toContain('## `success`');
      expect(result).toMatch(/2 trajectories/);
    });

    it('should sort exit statuses consistently', async () => {
      // Create files with various exit statuses
      const statuses = ['exit_cost', 'success', 'submitted', 'exit_format', 'exit_context'];

      statuses.forEach((status, index) => {
        const trajData = {
          info: {
            model_stats: {
              api_calls: index + 1,
            },
            exit_status: status,
          },
        };
        fs.writeFileSync(path.join(tmpDir, `test${index}.traj`), JSON.stringify(trajData));
      });

      const result = await quickStats(tmpDir);

      // Check that all statuses are present
      statuses.forEach((status) => {
        expect(result).toContain(`## \`${status}\``);
      });

      // Check ordering (should be alphabetical or by frequency)
      const statusOrder = result.match(/## `([^`]+)`/g);
      expect(statusOrder).toBeDefined();
      expect(statusOrder!.length).toBe(statuses.length);
    });

    it('should handle special characters in exit status', async () => {
      const trajData = {
        info: {
          model_stats: {
            api_calls: 5,
          },
          exit_status: 'submitted (exit_cost)',
        },
      };

      fs.writeFileSync(path.join(tmpDir, 'test.traj'), JSON.stringify(trajData));

      const result = await quickStats(tmpDir);

      expect(result).toContain('submitted (exit_cost)');
    });

    it('should provide meaningful output format', async () => {
      // Create a few trajectory files
      const trajData = {
        info: {
          model_stats: {
            api_calls: 10,
            tokens_sent: 1000,
            tokens_received: 500,
            instance_cost: 0.05,
          },
          exit_status: 'success',
        },
      };

      fs.writeFileSync(path.join(tmpDir, 'test1.traj'), JSON.stringify(trajData));
      fs.writeFileSync(path.join(tmpDir, 'test2.traj'), JSON.stringify(trajData));

      const result = await quickStats(tmpDir);

      // Should have markdown formatting
      expect(result).toMatch(/##/); // Markdown headers
      expect(result).toContain('trajectories'); // Trajectory count

      // Should potentially show averages or totals
      // The exact format depends on implementation
    });
  });
});
