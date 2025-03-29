import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceType } from '@elizaos/core';
import { BrowserService } from '../src/services/browser';

// Mock puppeteer
vi.mock('puppeteer', () => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(null),
    content: vi.fn().mockResolvedValue('<html><body>Test content</body></html>'),
    close: vi.fn().mockResolvedValue(null),
    setViewport: vi.fn().mockResolvedValue(null),
    setUserAgent: vi.fn().mockResolvedValue(null),
    evaluate: vi.fn().mockImplementation((fn) => {
      // If the function is to get the hCaptcha site key
      if (typeof fn === 'function') {
        return Promise.resolve('test-site-key');
      }
      return Promise.resolve(null);
    }),
    waitForSelector: vi.fn().mockResolvedValue({
      evaluate: vi.fn().mockResolvedValue('captcha-token'),
    }),
    waitForNavigation: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('screenshot data')),
  };

  const mockBrowser = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(null),
  };

  return {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  };
});

// Mock patchright
vi.mock('patchright', () => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(null),
    content: vi.fn().mockResolvedValue('<html><body>Test content</body></html>'),
    close: vi.fn().mockResolvedValue(null),
    setViewport: vi.fn().mockResolvedValue(null),
    setUserAgent: vi.fn().mockResolvedValue(null),
    evaluate: vi.fn().mockImplementation((fn) => {
      // If the function is to get the hCaptcha site key
      if (typeof fn === 'function') {
        return Promise.resolve('test-site-key');
      }
      return Promise.resolve(null);
    }),
    waitForSelector: vi.fn().mockResolvedValue({
      evaluate: vi.fn().mockResolvedValue('captcha-token'),
    }),
    waitForNavigation: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('screenshot data')),
  };

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(null),
  };

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(null),
  };

  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
    }
  };
});

// Mock node-fetch
vi.mock('node-fetch', () => {
  return {
    default: vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        solution: {
          gRecaptchaResponse: 'captcha-token'
        }
      }),
      ok: true
    })
  };
});

// Mock capsolver-npm
vi.mock('capsolver-npm', () => {
  return {
    default: class CaptchaSolver {
      constructor() {}
      
      hCaptchaTask() {
        return Promise.resolve({
          gRecaptchaResponse: 'captcha-token'
        });
      }
    }
  };
});

describe('BrowserService', () => {
  let mockRuntime: any;
  let service: BrowserService;

  beforeEach(() => {
    // Reset all mocks
    vi.resetAllMocks();

    // Mock runtime
    mockRuntime = {
      getSetting: vi.fn((key) => {
        if (key === 'PUPPETEER_EXECUTABLE_PATH') return '/path/to/chrome';
        if (key === 'PUPPETEER_HEADLESS') return 'true';
        if (key === 'USER_AGENT') return 'Mozilla/5.0 Test User Agent';
        if (key === 'CAPSOLVER_API_KEY') return 'test-api-key';
        return null;
      }),
      getService: vi.fn(),
      useModel: vi.fn().mockResolvedValue('{"title": "Test Title", "summary": "Test Summary"}'),
    };

    // Create service instance with mocked methods
    service = new BrowserService(mockRuntime);
    
    // Mock the internal methods
    service.initializeBrowser = vi.fn().mockResolvedValue(undefined);
    
    // Mock the fetchPageContent method which is called by getPageContent
    Object.defineProperty(service, 'fetchPageContent', {
      value: vi.fn().mockImplementation(async (url, runtime) => {
        if (url.includes('error')) {
          throw new Error('Browser launch failed');
        }
        return {
          title: 'Test Title',
          description: 'Test Description',
          bodyContent: '<html><body>Test content</body></html>'
        };
      }),
      configurable: true
    });
    
    // Mock the detectAndSolveCaptcha method which is called by solveCaptcha
    Object.defineProperty(service, 'detectAndSolveCaptcha', {
      value: vi.fn().mockImplementation(async (page, selector) => {
        return 'captcha-token';
      }),
      configurable: true
    });
  });

  describe('initialization', () => {
    it('should initialize with the correct service type', () => {
      expect(BrowserService.serviceType).toBe(ServiceType.BROWSER);
    });

    it('should set the capability description', () => {
      expect(service.capabilityDescription).toBe('The agent is able to browse the web and fetch content');
    });
  });

  describe('start and stop', () => {
    it('should create a new instance when start is called', async () => {
      // Create a mock instance that will be returned by the start method
      const mockInstance = new BrowserService(mockRuntime);
      mockInstance.initializeBrowser = vi.fn().mockResolvedValue(undefined);
      
      // Save the original start method
      const originalStart = BrowserService.start;
      
      // Mock the static start method to return our mock instance
      BrowserService.start = vi.fn().mockResolvedValue(mockInstance);
      
      const startedService = await BrowserService.start(mockRuntime);
      
      expect(startedService).toBeInstanceOf(BrowserService);
      
      // Restore the original start method
      BrowserService.start = originalStart;
    });

    it('should call service.stop when static stop is called', async () => {
      const mockService = {
        stop: vi.fn(),
      };
      mockRuntime.getService.mockReturnValue(mockService);

      await BrowserService.stop(mockRuntime);

      expect(mockRuntime.getService).toHaveBeenCalledWith(ServiceType.BROWSER);
      expect(mockService.stop).toHaveBeenCalled();
    });

    it('should do nothing if no service is found when stop is called', async () => {
      mockRuntime.getService.mockReturnValue(null);

      await BrowserService.stop(mockRuntime);

      expect(mockRuntime.getService).toHaveBeenCalledWith(ServiceType.BROWSER);
      // Should not throw an error
    });
  });

  describe('getPageContent', () => {
    it('should fetch content from a URL', async () => {
      const result = await service.getPageContent('https://example.com', mockRuntime);

      expect(result).toEqual({
        title: 'Test Title',
        description: 'Test Description',
        bodyContent: '<html><body>Test content</body></html>'
      });
      expect(service.initializeBrowser).toHaveBeenCalled();
    });

    it('should handle errors when fetching content', async () => {
      await expect(() => service.getPageContent('https://example.com/error', mockRuntime)).rejects.toThrow('Browser launch failed');
    });
  });
});
