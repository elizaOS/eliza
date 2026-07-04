/**
 * Failure-path tests for LocalTunnelService.stopTunnel().
 *
 * Regression cover for #12746 (#12275-H): a failed `tailscale serve/funnel
 * reset` MUST NOT fabricate a clean teardown. The public tunnel is still
 * exposed on the tailnet, so stopTunnel() has to fail closed — throw, keep the
 * service active, and never log "tunnel stopped". Isolated in its own file so
 * the `node:child_process` module mock does not leak into the sibling suite.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';

type SpawnScript = (cmd: string, args: string[]) => { code: number | null; stderr: string };

// Default: every spawned command succeeds. Individual tests override to
// simulate a failing `serve reset`.
let spawnScript: SpawnScript = () => ({ code: 0, stderr: '' });

mock.module('node:child_process', () => {
  const { EventEmitter } = require('node:events');
  const actual = require('node:child_process');
  return {
    ...actual,
    default: actual,
    spawn: (cmd: string, args: string[]) => {
      const child: {
        stdout: InstanceType<typeof EventEmitter>;
        stderr: InstanceType<typeof EventEmitter>;
        on: (event: string, cb: (arg: unknown) => void) => void;
        emit: (event: string, arg?: unknown) => void;
      } = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        // `which tailscale` — report installed so start()'s guard passes.
        if (cmd === 'which') {
          child.emit('exit', 0);
          return;
        }
        const { code, stderr } = spawnScript(cmd, args);
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('exit', code);
      });
      return child;
    },
  };
});

// Import AFTER the module mock is registered so the service picks up mocked spawn.
const { LocalTunnelService } = await import('../../services/LocalTunnelService');

function runtime(): IAgentRuntime {
  return {
    getSetting: mock(() => null),
  } as unknown as IAgentRuntime;
}

/**
 * Build a service whose install probe passes, then seed the private state so it
 * reports an active tunnel (state that would exist right after a successful
 * `startTunnel`). This exercises stopTunnel() without needing to script the
 * full serve + `status --json` DNSName startup handshake.
 */
async function activeService(): Promise<InstanceType<typeof LocalTunnelService>> {
  const svc = new LocalTunnelService(runtime());
  await svc.start();
  (svc as unknown as { tunnelUrl: string | null }).tunnelUrl = 'https://device.example.ts.net';
  (svc as unknown as { tunnelPort: number | null }).tunnelPort = 8080;
  return svc;
}

describe('LocalTunnelService.stopTunnel fail-closed (#12746)', () => {
  beforeEach(() => {
    spawnScript = () => ({ code: 0, stderr: '' });
  });

  it('throws and stays active when `tailscale serve reset` exits non-zero (tunnel still exposed)', async () => {
    const svc = await activeService();
    expect(svc.isActive()).toBe(true);

    spawnScript = (_cmd, args) => {
      if (args[0] === 'serve' && args[1] === 'reset') {
        return { code: 1, stderr: 'failed to connect to local tailscaled' };
      }
      return { code: 0, stderr: '' };
    };

    await expect(svc.stopTunnel()).rejects.toThrow(/serve reset exited with code 1/);

    // Fail closed: state preserved, service still reports active + exposed URL.
    expect(svc.isActive()).toBe(true);
    expect(svc.getUrl()).toBe('https://device.example.ts.net');
    expect(svc.getStatus().active).toBe(true);
  });

  it('names the still-exposed URL in the thrown error', async () => {
    const svc = await activeService();

    spawnScript = (_cmd, args) => {
      if (args[0] === 'serve' && args[1] === 'reset') {
        return { code: 1, stderr: 'tailscaled offline' };
      }
      return { code: 0, stderr: '' };
    };

    await expect(svc.stopTunnel()).rejects.toThrow(
      /Tunnel may still be exposed on https:\/\/device\.example\.ts\.net/
    );
  });

  it('tears down cleanly and reports inactive when reset exits zero', async () => {
    const svc = await activeService();

    spawnScript = () => ({ code: 0, stderr: '' });

    await expect(svc.stopTunnel()).resolves.toBeUndefined();
    expect(svc.isActive()).toBe(false);
    expect(svc.getUrl()).toBeNull();
    expect(svc.getStatus().active).toBe(false);
  });
});
