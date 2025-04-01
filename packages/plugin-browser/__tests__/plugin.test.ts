import { describe, expect, it, vi } from 'vitest';
import { ServiceType } from '@elizaos/core';
import { nodePlugin } from '../src/index';
import { AwsS3Service, BrowserService, PdfService, VideoService } from '../src/services';

// Mock youtube-dl-exec to fix the loading error
vi.mock('youtube-dl-exec', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      exec: vi.fn().mockResolvedValue({}),
    })),
    __esModule: true,
  };
});

describe('nodePlugin', () => {
  it('should have the correct name', () => {
    expect(nodePlugin.name).toBe('default');
  });

  it('should have the correct description', () => {
    expect(nodePlugin.description).toBe('Default plugin, with basic actions and evaluators');
  });

  it('should register the correct services', () => {
    expect(nodePlugin.services).toHaveLength(4);
    expect(nodePlugin.services).toContain(BrowserService);
    expect(nodePlugin.services).toContain(PdfService);
    expect(nodePlugin.services).toContain(VideoService);
    expect(nodePlugin.services).toContain(AwsS3Service);
  });

  it('should have empty actions array', () => {
    expect(nodePlugin.actions).toEqual([]);
  });
});

describe('Service Types', () => {
  it('should have the correct service type for BrowserService', () => {
    expect(BrowserService.serviceType).toBe(ServiceType.BROWSER);
  });

  it('should have the correct service type for PdfService', () => {
    expect(PdfService.serviceType).toBe(ServiceType.PDF);
  });

  it('should have the correct service type for VideoService', () => {
    expect(VideoService.serviceType).toBe(ServiceType.VIDEO);
  });

  it('should have the correct service type for AwsS3Service', () => {
    expect(AwsS3Service.serviceType).toBe(ServiceType.REMOTE_FILES);
  });
});
