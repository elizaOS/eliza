/**
 * CapSolver integration for solving various CAPTCHA types
 */

import { logger } from '@elizaos/core';
import axios from 'axios';

export interface CapSolverConfig {
  apiKey: string;
  apiUrl?: string;
  retryAttempts?: number;
  pollingInterval?: number;
}

export interface CaptchaTask {
  type: string;
  websiteURL: string;
  websiteKey: string;
  proxy?: string;
  userAgent?: string;
  [key: string]: any;
}

export class CapSolverService {
  private config: Required<CapSolverConfig>;

  constructor(config: CapSolverConfig) {
    this.config = {
      apiUrl: 'https://api.capsolver.com',
      retryAttempts: 60,
      pollingInterval: 2000,
      ...config,
    };
  }

  /**
   * Create a CAPTCHA solving task
   */
  async createTask(task: CaptchaTask): Promise<string> {
    try {
      const response = await axios.post(
        `${this.config.apiUrl}/createTask`,
        {
          clientKey: this.config.apiKey,
          task,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      if (response.data.errorId !== 0) {
        throw new Error(`CapSolver error: ${response.data.errorDescription || 'Unknown error'}`);
      }

      logger.info('CapSolver task created:', response.data.taskId);
      return response.data.taskId;
    } catch (error) {
      logger.error('Error creating CapSolver task:', error);
      throw error;
    }
  }

  /**
   * Get task result with polling
   */
  async getTaskResult(taskId: string): Promise<any> {
    let attempts = 0;

    while (attempts < this.config.retryAttempts) {
      try {
        const response = await axios.post(
          `${this.config.apiUrl}/getTaskResult`,
          {
            clientKey: this.config.apiKey,
            taskId,
          },
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );

        if (response.data.errorId !== 0) {
          throw new Error(`CapSolver error: ${response.data.errorDescription || 'Unknown error'}`);
        }

        if (response.data.status === 'ready') {
          logger.info('CapSolver task completed successfully');
          return response.data.solution;
        }

        // Still processing
        await new Promise((resolve) => setTimeout(resolve, this.config.pollingInterval));
        attempts++;
      } catch (error) {
        logger.error('Error getting CapSolver task result:', error);
        throw error;
      }
    }

    throw new Error('CapSolver task timeout');
  }

  /**
   * Solve Cloudflare Turnstile
   */
  async solveTurnstile(
    websiteURL: string,
    websiteKey: string,
    proxy?: string,
    userAgent?: string
  ): Promise<string> {
    logger.info('Solving Cloudflare Turnstile captcha');

    const task: CaptchaTask = {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL,
      websiteKey,
    };

    if (proxy) {
      // Use proxy version
      task.type = 'AntiTurnstileTask';
      const proxyParts = proxy.split(':');
      task.proxy = `${proxyParts[0]}:${proxyParts[1]}`;
      if (proxyParts.length > 2) {
        task.proxyLogin = proxyParts[2];
        task.proxyPassword = proxyParts[3];
      }
    }

    if (userAgent) {
      task.userAgent = userAgent;
    }

    const taskId = await this.createTask(task);
    const solution = await this.getTaskResult(taskId);

    return solution.token;
  }

  /**
   * Solve reCAPTCHA v2
   */
  async solveRecaptchaV2(
    websiteURL: string,
    websiteKey: string,
    isInvisible = false,
    proxy?: string
  ): Promise<string> {
    logger.info('Solving reCAPTCHA v2');

    const task: CaptchaTask = {
      type: proxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless',
      websiteURL,
      websiteKey,
      isInvisible,
    };

    if (proxy) {
      const proxyParts = proxy.split(':');
      task.proxy = `${proxyParts[0]}:${proxyParts[1]}`;
      if (proxyParts.length > 2) {
        task.proxyLogin = proxyParts[2];
        task.proxyPassword = proxyParts[3];
      }
    }

    const taskId = await this.createTask(task);
    const solution = await this.getTaskResult(taskId);

    return solution.gRecaptchaResponse;
  }

  /**
   * Solve reCAPTCHA v3
   */
  async solveRecaptchaV3(
    websiteURL: string,
    websiteKey: string,
    pageAction: string,
    minScore = 0.7,
    proxy?: string
  ): Promise<string> {
    logger.info('Solving reCAPTCHA v3');

    const task: CaptchaTask = {
      type: proxy ? 'RecaptchaV3Task' : 'RecaptchaV3TaskProxyless',
      websiteURL,
      websiteKey,
      pageAction,
      minScore,
    };

    if (proxy) {
      const proxyParts = proxy.split(':');
      task.proxy = `${proxyParts[0]}:${proxyParts[1]}`;
      if (proxyParts.length > 2) {
        task.proxyLogin = proxyParts[2];
        task.proxyPassword = proxyParts[3];
      }
    }

    const taskId = await this.createTask(task);
    const solution = await this.getTaskResult(taskId);

    return solution.gRecaptchaResponse;
  }

  /**
   * Solve hCaptcha
   */
  async solveHCaptcha(websiteURL: string, websiteKey: string, proxy?: string): Promise<string> {
    logger.info('Solving hCaptcha');

    const task: CaptchaTask = {
      type: proxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless',
      websiteURL,
      websiteKey,
    };

    if (proxy) {
      const proxyParts = proxy.split(':');
      task.proxy = `${proxyParts[0]}:${proxyParts[1]}`;
      if (proxyParts.length > 2) {
        task.proxyLogin = proxyParts[2];
        task.proxyPassword = proxyParts[3];
      }
    }

    const taskId = await this.createTask(task);
    const solution = await this.getTaskResult(taskId);

    return solution.token;
  }
}

/**
 * Helper to detect CAPTCHA type on a page
 */
export async function detectCaptchaType(page: any): Promise<{
  type: 'turnstile' | 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | null;
  siteKey?: string;
}> {
  try {
    // Check for Cloudflare Turnstile
    const turnstileElement = await page.$('[data-sitekey]');
    if (turnstileElement) {
      const siteKey = await page.evaluate(
        (el: any) => el.getAttribute('data-sitekey'),
        turnstileElement
      );
      if (siteKey && (await page.$('.cf-turnstile'))) {
        return { type: 'turnstile', siteKey };
      }
    }

    // Check for reCAPTCHA
    const recaptchaElement = await page.$('[data-sitekey], .g-recaptcha');
    if (recaptchaElement) {
      const siteKey = await page.evaluate(
        (el: any) => el.getAttribute('data-sitekey') || el.getAttribute('data-site-key'),
        recaptchaElement
      );
      if (siteKey) {
        // Check if it's v3 by looking for grecaptcha.execute
        const isV3 = await page.evaluate(() => {
          return typeof (globalThis as any).grecaptcha?.execute === 'function';
        });
        return { type: isV3 ? 'recaptcha-v3' : 'recaptcha-v2', siteKey };
      }
    }

    // Check for hCaptcha
    const hcaptchaElement = await page.$('[data-sitekey].h-captcha, [data-hcaptcha-sitekey]');
    if (hcaptchaElement) {
      const siteKey = await page.evaluate(
        (el: any) => el.getAttribute('data-sitekey') || el.getAttribute('data-hcaptcha-sitekey'),
        hcaptchaElement
      );
      if (siteKey) {
        return { type: 'hcaptcha', siteKey };
      }
    }

    return { type: null };
  } catch (error) {
    logger.error('Error detecting CAPTCHA type:', error);
    return { type: null };
  }
}

/**
 * Inject CAPTCHA solution into the page
 */
export async function injectCaptchaSolution(
  page: any,
  captchaType: string,
  solution: string
): Promise<void> {
  switch (captchaType) {
    case 'turnstile':
      await page.evaluate((token: string) => {
        // This code runs in the browser context
        const doc = globalThis as any;
        const textarea = doc.document.querySelector('[name="cf-turnstile-response"]');
        if (textarea) {
          textarea.value = token;
        }
        // Trigger any callbacks
        const callback = doc.turnstileCallback;
        if (callback) {
          callback(token);
        }
      }, solution);
      break;

    case 'recaptcha-v2':
    case 'recaptcha-v3':
      await page.evaluate((token: string) => {
        // This code runs in the browser context
        const doc = globalThis as any;
        const textarea = doc.document.querySelector('[name="g-recaptcha-response"]');
        if (textarea) {
          textarea.value = token;
          textarea.style.display = 'block';
        }
        // Trigger any callbacks
        const callback = doc.onRecaptchaSuccess || doc.recaptchaCallback;
        if (callback) {
          callback(token);
        }
      }, solution);
      break;

    case 'hcaptcha':
      await page.evaluate((token: string) => {
        // This code runs in the browser context
        const doc = globalThis as any;
        const textarea = doc.document.querySelector('[name="h-captcha-response"]');
        if (textarea) {
          textarea.value = token;
        }
        // Find the hCaptcha response input
        const input = doc.document.querySelector('[name="g-recaptcha-response"]');
        if (input) {
          input.value = token;
        }
        // Trigger any callbacks
        const callback = doc.hcaptchaCallback || doc.onHcaptchaSuccess;
        if (callback) {
          callback(token);
        }
      }, solution);
      break;
  }
}
