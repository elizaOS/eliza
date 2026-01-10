import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { autoPlugin } from '../src/index';
import { logger } from '@elizaos/core';
import dotenv from 'dotenv';
import { reflectAction } from '../src/reflect';
import { autonomousFeedProvider } from '../src/messageFeed';
import { worldProvider } from '../src/worldProvider';
import { OODALoopService } from '../src/ooda-service';
import { ResourceMonitorService } from '../src/resource-monitor';
import {
  browseWebAction,
  fileOperationAction,
  executeCommandAction,
  analyzeDataAction,
  gitOperationAction,
  packageManagementAction,
} from '../src/actions';

// Setup environment variables
dotenv.config();

// Spy on logger for testing
beforeAll(() => {
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  vi.spyOn(logger, 'warn');
  vi.spyOn(logger, 'debug');
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('Auto Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(autoPlugin.name).toBe('auto');
    expect(autoPlugin.description).toBe('Autonomous operations plugin with OODA loop decision-making and real action execution');
    expect(autoPlugin.tests).toBeDefined();
  });

  it('should have the OODA and Resource Monitor services', () => {
    expect(autoPlugin.services).toBeDefined();
    expect(autoPlugin.services).toContain(OODALoopService);
    expect(autoPlugin.services).toContain(ResourceMonitorService);
  });

  it('should have real action handlers', () => {
    expect(autoPlugin.actions).toBeDefined();
    
    const expectedActions = [
      browseWebAction,
      fileOperationAction,
      executeCommandAction,
      analyzeDataAction,
      gitOperationAction,
      packageManagementAction,
      reflectAction
    ];

    expectedActions.forEach(action => {
      expect(autoPlugin.actions).toContain(action);
    });
  });

  it('should have the autonomous feed and world providers', () => {
    expect(autoPlugin.providers).toBeDefined();
    expect(autoPlugin.providers).toContain(autonomousFeedProvider);
    expect(autoPlugin.providers).toContain(worldProvider);
  });

  it('should have the OODALoopService', () => {
    expect(autoPlugin.services).toBeDefined();
    expect(autoPlugin.services?.length).toBe(2); // OODA and ResourceMonitor
    
    const hasOODAService = autoPlugin.services?.some(
      service => service === OODALoopService || service.serviceType === 'autonomous'
    );
    expect(hasOODAService).toBe(true);
  });

  it('should have e2e tests exported', () => {
    expect(autoPlugin.tests).toBeDefined();
    expect(Array.isArray(autoPlugin.tests)).toBe(true);
    expect(autoPlugin.tests?.length).toBeGreaterThan(0);
  });

  it('should have init function for API server', () => {
    expect(autoPlugin.init).toBeDefined();
    expect(typeof autoPlugin.init).toBe('function');
  });
});

describe('Auto Plugin Actions', () => {
  it('should have valid REFLECT action structure', () => {
    expect(reflectAction).toBeDefined();
    expect(reflectAction.name).toBe('REFLECT');
    expect(reflectAction.similes).toContain('REFLECTION');
    expect(reflectAction.description).toContain('process the current situation');
    expect(reflectAction.validate).toBeDefined();
    expect(reflectAction.handler).toBeDefined();
    expect(reflectAction.examples).toBeDefined();
    expect(Array.isArray(reflectAction.examples)).toBe(true);
  });

  it('should have valid browse web action', () => {
    expect(browseWebAction).toBeDefined();
    expect(browseWebAction.name).toBe('BROWSE_WEB');
    expect(browseWebAction.validate).toBeDefined();
    expect(browseWebAction.handler).toBeDefined();
  });

  it('should have valid file operation action', () => {
    expect(fileOperationAction).toBeDefined();
    expect(fileOperationAction.name).toBe('FILE_OPERATION');
    expect(fileOperationAction.validate).toBeDefined();
    expect(fileOperationAction.handler).toBeDefined();
  });

  it('should have valid command execution action', () => {
    expect(executeCommandAction).toBeDefined();
    expect(executeCommandAction.name).toBe('EXECUTE_COMMAND');
    expect(executeCommandAction.validate).toBeDefined();
    expect(executeCommandAction.handler).toBeDefined();
  });
});

describe('Auto Plugin Providers', () => {
  it('should have valid autonomous feed provider structure', () => {
    expect(autonomousFeedProvider).toBeDefined();
    expect(autonomousFeedProvider.name).toBe('AUTONOMOUS_FEED');
    expect(autonomousFeedProvider.description).toContain('feed of messages');
    expect(autonomousFeedProvider.get).toBeDefined();
    expect(typeof autonomousFeedProvider.get).toBe('function');
  });

  it('should have valid world provider structure', () => {
    expect(worldProvider).toBeDefined();
    expect(worldProvider.name).toBe('AUTONOMOUS_WORLD_CONTEXT');
    expect(worldProvider.description).toContain('dynamic context');
    expect(worldProvider.get).toBeDefined();
    expect(typeof worldProvider.get).toBe('function');
    expect(worldProvider.dynamic).toBe(true);
  });
});

describe('Auto Plugin Services', () => {
  it('should have OODALoopService with correct properties', () => {
    expect(OODALoopService.serviceType).toBe('autonomous');
    expect(OODALoopService.start).toBeDefined();
    expect(typeof OODALoopService.start).toBe('function');
  });

  it('should have ResourceMonitorService with correct properties', () => {
    expect(ResourceMonitorService.serviceType).toBe('resource-monitor');
    expect(ResourceMonitorService.start).toBeDefined();
    expect(typeof ResourceMonitorService.start).toBe('function');
  });
});
