import { describe, expect, it, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '@elizaos/core';
import axios from 'axios';
import { CapSolverService, detectCaptchaType, injectCaptchaSolution } from '../capsolver';

// Helper to create mock AxiosResponse
const createMockResponse = (data: any) => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: {},
  config: {
    url: '',
    method: 'post',
    headers: {},
  } as any,
  request: {},
});

// Mock logger
mock.module('@elizaos/core', () => ({
  logger: {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
  },
}));

describe('CapSolverService', () => {
  let capSolver: CapSolverService;
  const mockApiKey = 'test-api-key';

  beforeEach(() => {
    capSolver = new CapSolverService({ apiKey: mockApiKey });
  });

  afterEach(() => {
    mock.restore();
  });

  describe('createTask', () => {
    it('should create a task successfully', async () => {
      const mockTaskId = 'task-123';
      const postSpy = spyOn(axios, 'post').mockResolvedValueOnce(
        createMockResponse({
          errorId: 0,
          taskId: mockTaskId,
        })
      );

      const task = {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: 'https://example.com',
        websiteKey: 'test-key',
      };

      const taskId = await capSolver.createTask(task);

      expect(taskId).toBe(mockTaskId);
      expect(postSpy).toHaveBeenCalledWith(
        'https://api.capsolver.com/createTask',
        {
          clientKey: mockApiKey,
          task,
        },
        expect.any(Object)
      );
    });

    it('should throw error when API returns error', async () => {
      spyOn(axios, 'post').mockResolvedValueOnce(
        createMockResponse({
          errorId: 1,
          errorDescription: 'Invalid API key',
        })
      );

      const task = {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: 'https://example.com',
        websiteKey: 'test-key',
      };

      await expect(capSolver.createTask(task)).rejects.toThrow('CapSolver error: Invalid API key');
    });
  });

  describe('getTaskResult', () => {
    it('should return solution when task is ready', async () => {
      const mockSolution = { token: 'solved-token' };
      spyOn(axios, 'post').mockResolvedValueOnce(
        createMockResponse({
          errorId: 0,
          status: 'ready',
          solution: mockSolution,
        })
      );

      const result = await capSolver.getTaskResult('task-123');

      expect(result).toEqual(mockSolution);
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.capsolver.com/getTaskResult',
        {
          clientKey: mockApiKey,
          taskId: 'task-123',
        },
        expect.any(Object)
      );
    });

    it('should poll until task is ready', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'processing',
          })
        )
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { token: 'solved-token' },
          })
        );

      // Reduce polling interval for testing
      const fastCapSolver = new CapSolverService({
        apiKey: mockApiKey,
        pollingInterval: 10, // 10ms for testing
      });

      const result = await fastCapSolver.getTaskResult('task-123');

      expect(result).toEqual({ token: 'solved-token' });
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('should throw error on timeout', async () => {
      spyOn(axios, 'post').mockResolvedValue(
        createMockResponse({
          errorId: 0,
          status: 'processing',
        })
      );

      const fastCapSolver = new CapSolverService({
        apiKey: mockApiKey,
        pollingInterval: 10,
        retryAttempts: 2,
      });

      await expect(fastCapSolver.getTaskResult('task-123')).rejects.toThrow(
        'CapSolver task timeout'
      );
    });
  });

  describe('solveTurnstile', () => {
    it('should solve Turnstile captcha', async () => {
      const mockTaskId = 'task-123';
      const mockToken = 'turnstile-token';

      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: mockTaskId }))
        .mockResolvedValueOnce(
          createMockResponse({ errorId: 0, status: 'ready', solution: { token: mockToken } })
        );

      const token = await capSolver.solveTurnstile('https://example.com', 'site-key');

      expect(token).toBe(mockToken);
      expect(logger.info).toHaveBeenCalledWith('Solving Cloudflare Turnstile captcha');
    });

    it('should use proxy when provided', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-123' }))
        .mockResolvedValueOnce(
          createMockResponse({ errorId: 0, status: 'ready', solution: { token: 'proxy-token' } })
        );

      await capSolver.solveTurnstile(
        'https://example.com',
        'site-key',
        'proxy-host:8080:username:password'
      );

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.capsolver.com/createTask',
        expect.objectContaining({
          task: expect.objectContaining({
            type: 'AntiTurnstileTask',
            proxy: 'proxy-host:8080',
            proxyLogin: 'username',
            proxyPassword: 'password',
          }),
        }),
        expect.any(Object)
      );
    });
  });

  describe('solveRecaptchaV2', () => {
    it('should solve reCAPTCHA v2', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-456' }))
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { gRecaptchaResponse: 'recaptcha-v2-token' },
          })
        );

      const result = await capSolver.solveRecaptchaV2('https://example.com', 'v2-site-key');

      expect(result).toBe('recaptcha-v2-token');
      expect(logger.info).toHaveBeenCalledWith('Solving reCAPTCHA v2');
    });

    it('should handle invisible reCAPTCHA v2', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-789' }))
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { gRecaptchaResponse: 'invisible-token' },
          })
        );

      const result = await capSolver.solveRecaptchaV2('https://example.com', 'invisible-key', true);

      expect(result).toBe('invisible-token');
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.capsolver.com/createTask',
        expect.objectContaining({
          task: expect.objectContaining({
            isInvisible: true,
          }),
        }),
        expect.any(Object)
      );
    });
  });

  describe('solveRecaptchaV3', () => {
    it('should solve reCAPTCHA v3', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-v3' }))
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { gRecaptchaResponse: 'v3-token' },
          })
        );

      const result = await capSolver.solveRecaptchaV3('https://example.com', 'v3-key', 'verify');

      expect(result).toBe('v3-token');
      expect(logger.info).toHaveBeenCalledWith('Solving reCAPTCHA v3');
    });

    it('should use custom action and score', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-v3-custom' }))
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { gRecaptchaResponse: 'v3-custom-token' },
          })
        );

      const result = await capSolver.solveRecaptchaV3(
        'https://example.com',
        'v3-key',
        'login',
        0.7
      );

      expect(result).toBe('v3-custom-token');
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.capsolver.com/createTask',
        expect.objectContaining({
          task: expect.objectContaining({
            pageAction: 'login',
            minScore: 0.7,
          }),
        }),
        expect.any(Object)
      );
    });
  });

  describe('solveHCaptcha', () => {
    it('should solve hCaptcha', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-hcaptcha' }))
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { token: 'hcaptcha-token' },
          })
        );

      const result = await capSolver.solveHCaptcha('https://example.com', 'hcaptcha-key');

      expect(result).toBe('hcaptcha-token');
      expect(logger.info).toHaveBeenCalledWith('Solving hCaptcha');
    });

    it('should use proxy when provided', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-hcaptcha-proxy' }))
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { token: 'hcaptcha-proxy-token' },
          })
        );

      await capSolver.solveHCaptcha(
        'https://example.com',
        'hcaptcha-key',
        'proxy-host:8080:username:password'
      );

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.capsolver.com/createTask',
        expect.objectContaining({
          task: expect.objectContaining({
            type: 'HCaptchaTask',
            proxy: 'proxy-host:8080',
            proxyLogin: 'username',
            proxyPassword: 'password',
          }),
        }),
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      spyOn(axios, 'post').mockRejectedValueOnce(new Error('Network error'));

      await expect(
        capSolver.createTask({
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: 'https://example.com',
          websiteKey: 'test-key',
        })
      ).rejects.toThrow('Network error');

      expect(logger.error).toHaveBeenCalledWith(
        'Error creating CapSolver task:',
        expect.any(Error)
      );
    });

    it('should handle invalid proxy format', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-proxy-error' }))
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { token: 'proxy-error-token' },
          })
        );

      // Should not throw, but handle gracefully
      await expect(
        capSolver.solveTurnstile('https://example.com', 'site-key', 'invalid-proxy')
      ).resolves.toBe('proxy-error-token');
    });

    it('should retry on task polling errors', async () => {
      spyOn(axios, 'post')
        .mockResolvedValueOnce(createMockResponse({ errorId: 0, taskId: 'task-retry' }))
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce(
          createMockResponse({
            errorId: 0,
            status: 'ready',
            solution: { token: 'retry-token' },
          })
        );

      // This should fail because getTaskResult doesn't retry on errors
      await expect(capSolver.solveTurnstile('https://example.com', 'site-key')).rejects.toThrow(
        'Temporary error'
      );
    });
  });
});

describe('detectCaptchaType', () => {
  let mockPage: any;

  beforeEach(() => {
    mockPage = {
      $: mock(),
      evaluate: mock(),
    };
  });

  it('should detect Cloudflare Turnstile', async () => {
    const mockElement = {};
    mockPage.$.mockImplementation((selector: string) => {
      if (selector === '[data-sitekey]') {
        return Promise.resolve(mockElement);
      }
      if (selector === '.cf-turnstile') {
        return Promise.resolve(mockElement);
      }
      return Promise.resolve(null);
    });
    mockPage.evaluate.mockResolvedValue('test-sitekey');

    const result = await detectCaptchaType(mockPage);

    expect(result).toEqual({
      type: 'turnstile',
      siteKey: 'test-sitekey',
    });
  });

  it('should detect reCAPTCHA v2', async () => {
    const mockElement = {};
    mockPage.$.mockImplementation((selector: string) => {
      if (selector === '[data-sitekey], .g-recaptcha') {
        return Promise.resolve(mockElement);
      }
      return Promise.resolve(null);
    });
    mockPage.evaluate.mockResolvedValueOnce('recaptcha-sitekey').mockResolvedValueOnce(false); // Not v3

    const result = await detectCaptchaType(mockPage);

    expect(result).toEqual({
      type: 'recaptcha-v2',
      siteKey: 'recaptcha-sitekey',
    });
  });

  it('should detect reCAPTCHA v3', async () => {
    const mockElement = {};
    mockPage.$.mockImplementation((selector: string) => {
      if (selector === '[data-sitekey], .g-recaptcha') {
        return Promise.resolve(mockElement);
      }
      return Promise.resolve(null);
    });
    mockPage.evaluate.mockResolvedValueOnce('recaptcha-sitekey').mockResolvedValueOnce(true); // Is v3

    const result = await detectCaptchaType(mockPage);

    expect(result).toEqual({
      type: 'recaptcha-v3',
      siteKey: 'recaptcha-sitekey',
    });
  });

  it('should detect hCaptcha', async () => {
    const mockElement = {};
    mockPage.$.mockImplementation((selector: string) => {
      if (selector === '[data-sitekey].h-captcha, [data-hcaptcha-sitekey]') {
        return Promise.resolve(mockElement);
      }
      return Promise.resolve(null);
    });
    mockPage.evaluate.mockResolvedValue('hcaptcha-sitekey');

    const result = await detectCaptchaType(mockPage);

    expect(result).toEqual({
      type: 'hcaptcha',
      siteKey: 'hcaptcha-sitekey',
    });
  });

  it('should return null when no captcha found', async () => {
    mockPage.$.mockResolvedValue(null);

    const result = await detectCaptchaType(mockPage);

    expect(result).toEqual({ type: null });
  });
});

describe('injectCaptchaSolution', () => {
  let mockPage: any;

  beforeEach(() => {
    mockPage = {
      evaluate: mock(),
    };
  });

  it('should inject Turnstile solution', async () => {
    await injectCaptchaSolution(mockPage, 'turnstile', 'test-token');

    expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), 'test-token');
  });

  it('should inject reCAPTCHA solution', async () => {
    await injectCaptchaSolution(mockPage, 'recaptcha-v2', 'test-token');

    expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), 'test-token');
  });

  it('should inject hCaptcha solution', async () => {
    await injectCaptchaSolution(mockPage, 'hcaptcha', 'test-token');

    expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), 'test-token');
  });
});
