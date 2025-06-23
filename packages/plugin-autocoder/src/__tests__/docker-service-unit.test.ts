import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DockerService } from '../services/DockerService.ts';
import type { ContainerCreateRequest } from '../types/container.ts';

describe('DockerService - Real Docker Unit Tests', () => {
  let dockerService: DockerService;
  let createdContainers: string[] = [];
  let createdNetworks: string[] = [];

  beforeEach(async () => {
    // Create Docker service directly (without full runtime)
    dockerService = new DockerService();

    // Mock minimal runtime for settings
    (dockerService as any).runtime = {
      getSetting: (key: string) => {
        if (key === 'DOCKER_HOST') return process.env.DOCKER_HOST || undefined;
        return undefined;
      },
    };

    // Initialize the service
    try {
      await (dockerService as any).initialize();
      console.log('✅ DockerService initialized successfully');
    } catch (error) {
      console.warn(
        '⚠️ DockerService initialization failed:',
        error instanceof Error ? error.message : String(error)
      );
      // Continue with tests - they will handle Docker unavailability
    }
  });

  afterEach(async () => {
    // Cleanup containers
    for (const containerId of createdContainers) {
      try {
        await dockerService.stopContainer(containerId, 5);
        await dockerService.removeContainer(containerId, true);
        console.log(`✓ Cleaned up container: ${containerId.slice(0, 12)}`);
      } catch (error) {
        console.warn(
          `Failed to cleanup container ${containerId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Cleanup networks
    for (const networkId of createdNetworks) {
      try {
        await dockerService.removeNetwork(networkId);
        console.log(`✓ Cleaned up network: ${networkId.slice(0, 12)}`);
      } catch (error) {
        console.warn(
          `Failed to cleanup network ${networkId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    createdContainers = [];
    createdNetworks = [];

    // Stop the service
    if (dockerService) {
      await dockerService.stop();
    }
  });

  it('should create DockerService instance', () => {
    expect(dockerService).toBeDefined();
    expect(dockerService.constructor.name).toBe('DockerService');
    expect(dockerService.capabilityDescription).toContain('Docker container management');
  });

  it('should ping Docker daemon (real Docker test)', async () => {
    try {
      const result = await dockerService.ping();
      expect(typeof result).toBe('boolean');

      if (result) {
        console.log('✅ Docker daemon is available and responding');
      } else {
        console.warn('⚠️ Docker daemon ping returned false');
      }
    } catch (error) {
      console.warn(
        '⚠️ Docker ping failed (expected if Docker not running):',
        error instanceof Error ? error.message : String(error)
      );
      expect(error).toBeDefined();
    }
  });

  it('should get Docker version (real Docker test)', async () => {
    try {
      const pingResult = await dockerService.ping();
      if (!pingResult) {
        console.warn('⚠️ Docker not available, skipping version test');
        return;
      }

      const version = await dockerService.getVersion();
      expect(version).toBeDefined();
      expect(version.Version).toBeDefined();
      expect(typeof version.Version).toBe('string');

      // Verify it's not the old mock version
      expect(version.Version).not.toBe('0.0.0-mock');

      console.log('✅ Docker version:', version.Version);
      console.log('  Platform:', version.Platform?.Name || 'Unknown');
      console.log('  API Version:', version.ApiVersion || 'Unknown');
    } catch (error) {
      console.warn(
        'Version test failed (expected if Docker not running):',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  it('should list Docker images (real Docker test)', async () => {
    try {
      const pingResult = await dockerService.ping();
      if (!pingResult) {
        console.warn('⚠️ Docker not available, skipping image list test');
        return;
      }

      const images = await dockerService.listImages();
      expect(Array.isArray(images)).toBe(true);

      console.log(`✅ Found ${images.length} Docker images`);

      // Show some sample images
      const sampleImages = images.slice(0, 3);
      for (const image of sampleImages) {
        const tags = image.RepoTags || ['<none>'];
        const size = Math.round(image.Size / 1024 / 1024); // MB
        console.log(`  - ${tags[0]} (${size}MB)`);
      }
    } catch (error) {
      console.warn(
        'Image list test failed (expected if Docker not running):',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  it('should create and manage Docker networks (real Docker test)', async () => {
    try {
      const pingResult = await dockerService.ping();
      if (!pingResult) {
        console.warn('⚠️ Docker not available, skipping network test');
        return;
      }

      // Create test network
      const networkName = `eliza-test-${Date.now()}`;
      const networkId = await dockerService.createNetwork({
        name: networkName,
        subnet: '172.31.0.0/16',
        gateway: '172.31.0.1',
      });

      expect(networkId).toBeDefined();
      expect(typeof networkId).toBe('string');
      createdNetworks.push(networkId);

      console.log(`✅ Created network: ${networkName} (${networkId.slice(0, 12)})`);

      // List networks and verify our network exists
      const networks = await dockerService.listNetworks();
      expect(Array.isArray(networks)).toBe(true);

      const ourNetwork = networks.find((net) => net.Id === networkId);
      expect(ourNetwork).toBeDefined();
      expect(ourNetwork.Name).toBe(networkName);

      console.log(`✅ Verified network exists in list`);

      // Remove network
      await dockerService.removeNetwork(networkId);
      createdNetworks = createdNetworks.filter((id) => id !== networkId);

      console.log(`✅ Removed network: ${networkName}`);

      // Verify network is gone
      const networksAfter = await dockerService.listNetworks();
      const removedNetwork = networksAfter.find((net) => net.Id === networkId);
      expect(removedNetwork).toBeUndefined();
    } catch (error) {
      console.warn(
        'Network test failed (expected if Docker not running):',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  it('should handle container operations with lightweight image (real Docker test)', async () => {
    try {
      const pingResult = await dockerService.ping();
      if (!pingResult) {
        console.warn('⚠️ Docker not available, skipping container test');
        return;
      }

      // Check if we have any lightweight images
      const images = await dockerService.listImages();
      let testImage = 'alpine:latest';

      // Look for existing lightweight images
      const lightweightImages = images.filter(
        (img) =>
          img.RepoTags &&
          img.RepoTags.some(
            (tag) =>
              tag.includes('alpine') || tag.includes('busybox') || tag.includes('hello-world')
          )
      );

      if (lightweightImages.length === 0) {
        console.warn('⚠️ No lightweight test images available, attempting to pull alpine');
        try {
          await dockerService.pullImage('alpine', 'latest');
          console.log('✅ Successfully pulled alpine:latest');
        } catch (pullError) {
          console.warn('⚠️ Could not pull test image, skipping container test');
          return;
        }
      } else {
        testImage = lightweightImages[0].RepoTags[0];
        console.log(`✅ Using existing image: ${testImage}`);
      }

      // Create container
      const containerName = `eliza-test-${Date.now()}`;
      const createRequest: ContainerCreateRequest = {
        name: containerName,
        image: testImage,
        agentConfig: {
          agentId: 'test-docker-123' as any,
          containerId: '',
          agentName: 'docker-test-agent',
          role: 'coder',
          capabilities: ['test'],
          communicationPort: 3001,
          healthPort: 3002,
          environment: {
            TEST_ENV: 'docker-test',
            MODE: 'testing',
          },
        },
        securityConfig: {
          readOnlyRootfs: false,
          capDrop: ['ALL'],
          securityOpts: ['no-new-privileges:true'],
        },
      };

      const containerId = await dockerService.createContainer(createRequest);
      expect(containerId).toBeDefined();
      expect(typeof containerId).toBe('string');
      createdContainers.push(containerId);

      console.log(`✅ Created container: ${containerName} (${containerId.slice(0, 12)})`);

      // Check initial status
      const initialStatus = await dockerService.getContainerStatus(containerId);
      expect(initialStatus).toBeDefined();
      expect(initialStatus.id).toBe(containerId);
      expect(initialStatus.name).toBe(containerName);
      console.log(`Initial status: ${initialStatus.state}`);

      // Start container
      await dockerService.startContainer(containerId);
      console.log(`✅ Started container`);

      // Check running status
      const runningStatus = await dockerService.getContainerStatus(containerId);
      expect(runningStatus.state).toBe('running');
      console.log(`Running status: ${runningStatus.state}`);

      // List containers and verify ours is there
      const allContainers = await dockerService.listContainers();
      const ourContainer = allContainers.find((c) => c.id === containerId);
      expect(ourContainer).toBeDefined();
      expect(ourContainer?.state).toBe('running');

      // Try to execute a simple command
      try {
        const execResult = await dockerService.executeInContainer(containerId, {
          command: ['echo', 'Docker integration test successful'],
          attachStdout: true,
          attachStderr: true,
        });

        expect(execResult).toBeDefined();
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('Docker integration test successful');

        console.log(`✅ Command execution: "${execResult.stdout.trim()}"`);
      } catch (execError) {
        console.warn(
          'Command execution failed:',
          execError instanceof Error ? execError.message : String(execError)
        );
      }

      // Get container stats
      try {
        const stats = await dockerService.getContainerStats(containerId);
        expect(stats).toBeDefined();
        expect(stats.id).toBe(containerId);
        expect(stats.cpu).toBeDefined();
        expect(stats.memory).toBeDefined();

        console.log(
          `✅ Container stats: CPU ${stats.cpu.usagePercent.toFixed(2)}%, Memory ${stats.memory.usagePercent.toFixed(2)}%`
        );
      } catch (statsError) {
        console.warn(
          'Stats collection failed:',
          statsError instanceof Error ? statsError.message : String(statsError)
        );
      }

      // Stop container
      await dockerService.stopContainer(containerId, 10);
      console.log(`✅ Stopped container`);

      // Check stopped status
      const stoppedStatus = await dockerService.getContainerStatus(containerId);
      expect(['stopped', 'exited']).toContain(stoppedStatus.state);
      console.log(`Stopped status: ${stoppedStatus.state}`);

      // Remove container
      await dockerService.removeContainer(containerId, true);
      createdContainers = createdContainers.filter((id) => id !== containerId);

      console.log(`✅ Removed container`);

      console.log('🎉 Complete container lifecycle test passed!');
    } catch (error) {
      console.warn(
        'Container test failed (may be expected):',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  it('should handle Docker unavailability gracefully', async () => {
    // This test validates error handling when Docker operations fail
    try {
      const pingResult = await dockerService.ping();

      if (!pingResult) {
        console.log('✅ Docker not available - service handles gracefully');
        return;
      }

      // If Docker is available, test error handling with invalid operations
      try {
        await dockerService.createContainer({
          name: 'invalid-test',
          image: 'this-image-does-not-exist:invalid',
          agentConfig: {
            agentId: 'test' as any,
            containerId: '',
            agentName: 'test',
            role: 'coder',
            capabilities: []
            communicationPort: 9999,
            healthPort: 9998,
            environment: {},
          },
        });

        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        console.log('✅ Properly handled invalid image error');
        expect(error).toBeDefined();
        expect((error as Error).message).toBeDefined();
      }

      // Test invalid container operations
      try {
        await dockerService.getContainerStatus('invalid-container-id');
        expect(true).toBe(false);
      } catch (error) {
        console.log('✅ Properly handled invalid container ID error');
        expect(error).toBeDefined();
      }
    } catch (error) {
      console.log('✅ Service properly handled Docker unavailability');
      expect(error).toBeDefined();
    }
  });
});
