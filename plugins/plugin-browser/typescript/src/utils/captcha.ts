import { logger } from "@elizaos/core";
import axios from "axios";
import type { CapSolverConfig, CaptchaTask, CaptchaType } from "../types.js";

interface CapSolverTaskResult {
  token?: string;
  gRecaptchaResponse?: string;
}

export class CapSolverService {
  private readonly apiUrl: string;
  private readonly retryAttempts: number;
  private readonly pollingInterval: number;

  constructor(private config: CapSolverConfig) {
    this.apiUrl = config.apiUrl ?? "https://api.capsolver.com";
    this.retryAttempts = config.retryAttempts ?? 60;
    this.pollingInterval = config.pollingInterval ?? 2000;
  }

  /**
   * Create a CAPTCHA solving task
   */
  async createTask(task: CaptchaTask): Promise<string> {
    try {
      const response = await axios.post(
        `${this.apiUrl}/createTask`,
        {
          clientKey: this.config.apiKey,
          task,
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
        }
      );

      if (response.data.errorId !== 0) {
        throw new Error(`CapSolver error: ${response.data.errorDescription ?? "Unknown error"}`);
      }

      logger.info("CapSolver task created:", response.data.taskId);
      return response.data.taskId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error creating CapSolver task: ${errorMessage}`);
      throw error;
    }
  }

  async getTaskResult(taskId: string): Promise<CapSolverTaskResult> {
    let attempts = 0;

    while (attempts < this.retryAttempts) {
      try {
        const response = await axios.post(
          `${this.apiUrl}/getTaskResult`,
          {
            clientKey: this.config.apiKey,
            taskId,
          },
          {
            headers: { "Content-Type": "application/json" },
            timeout: 30000,
          }
        );

        if (response.data.errorId !== 0) {
          throw new Error(`CapSolver error: ${response.data.errorDescription ?? "Unknown error"}`);
        }

        if (response.data.status === "ready") {
          logger.info("CapSolver task completed successfully");
          return response.data.solution;
        }

        await new Promise((resolve) => setTimeout(resolve, this.pollingInterval));
        attempts++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Error getting CapSolver task result: ${errorMessage}`);
        throw error;
      }
    }

    throw new Error("CapSolver task timeout");
  }

  async solveTurnstile(
    websiteURL: string,
    websiteKey: string,
    proxy?: string,
    userAgent?: string
  ): Promise<string> {
    logger.info("Solving Cloudflare Turnstile captcha");

    const task: CaptchaTask = {
      type: proxy ? "AntiTurnstileTask" : "AntiTurnstileTaskProxyLess",
      websiteURL,
      websiteKey,
    };

    if (proxy) {
      const proxyParts = proxy.split(":");
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

    return solution.token ?? "";
  }

  async solveRecaptchaV2(
    websiteURL: string,
    websiteKey: string,
    isInvisible = false,
    proxy?: string
  ): Promise<string> {
    logger.info("Solving reCAPTCHA v2");

    const task: CaptchaTask = {
      type: proxy ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless",
      websiteURL,
      websiteKey,
      isInvisible,
    };

    if (proxy) {
      const proxyParts = proxy.split(":");
      task.proxy = `${proxyParts[0]}:${proxyParts[1]}`;
      if (proxyParts.length > 2) {
        task.proxyLogin = proxyParts[2];
        task.proxyPassword = proxyParts[3];
      }
    }

    const taskId = await this.createTask(task);
    const solution = await this.getTaskResult(taskId);

    return solution.gRecaptchaResponse ?? "";
  }

  async solveRecaptchaV3(
    websiteURL: string,
    websiteKey: string,
    pageAction: string,
    minScore = 0.7,
    proxy?: string
  ): Promise<string> {
    logger.info("Solving reCAPTCHA v3");

    const task: CaptchaTask = {
      type: proxy ? "RecaptchaV3Task" : "RecaptchaV3TaskProxyless",
      websiteURL,
      websiteKey,
      pageAction,
      minScore,
    };

    if (proxy) {
      const proxyParts = proxy.split(":");
      task.proxy = `${proxyParts[0]}:${proxyParts[1]}`;
      if (proxyParts.length > 2) {
        task.proxyLogin = proxyParts[2];
        task.proxyPassword = proxyParts[3];
      }
    }

    const taskId = await this.createTask(task);
    const solution = await this.getTaskResult(taskId);

    return solution.gRecaptchaResponse ?? "";
  }

  async solveHCaptcha(websiteURL: string, websiteKey: string, proxy?: string): Promise<string> {
    logger.info("Solving hCaptcha");

    const task: CaptchaTask = {
      type: proxy ? "HCaptchaTask" : "HCaptchaTaskProxyless",
      websiteURL,
      websiteKey,
    };

    if (proxy) {
      const proxyParts = proxy.split(":");
      task.proxy = `${proxyParts[0]}:${proxyParts[1]}`;
      if (proxyParts.length > 2) {
        task.proxyLogin = proxyParts[2];
        task.proxyPassword = proxyParts[3];
      }
    }

    const taskId = await this.createTask(task);
    const solution = await this.getTaskResult(taskId);

    return solution.token ?? "";
  }
}

export async function detectCaptchaType(page: {
  $: (selector: string) => Promise<Element | null>;
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<{
  type: CaptchaType;
  siteKey?: string;
}> {
  try {
    const turnstileElement = await page.$("[data-sitekey]");
    if (turnstileElement) {
      const cfTurnstile = await page.$(".cf-turnstile");
      if (cfTurnstile) {
        return { type: "turnstile" };
      }
    }

    const recaptchaElement = await page.$("[data-sitekey], .g-recaptcha");
    if (recaptchaElement) {
      const isV3 = await page.evaluate(() => {
        const grecaptcha = (
          globalThis as typeof globalThis & {
            grecaptcha?: { execute?: () => void };
          }
        ).grecaptcha;
        return typeof grecaptcha?.execute === "function";
      });
      return { type: isV3 ? "recaptcha-v3" : "recaptcha-v2" };
    }

    const hcaptchaElement = await page.$("[data-sitekey].h-captcha, [data-hcaptcha-sitekey]");
    if (hcaptchaElement) {
      return { type: "hcaptcha" };
    }

    return { type: "none" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error detecting CAPTCHA type: ${errorMessage}`);
    return { type: "none" };
  }
}

export async function injectCaptchaSolution(
  page: { evaluate: <T>(fn: (token: string) => T, token: string) => Promise<T> },
  captchaType: CaptchaType,
  solution: string
): Promise<void> {
  switch (captchaType) {
    case "turnstile":
      await page.evaluate((token: string) => {
        const doc = globalThis as typeof globalThis & {
          document: Document;
          turnstileCallback?: (token: string) => void;
        };
        const textarea = doc.document.querySelector(
          '[name="cf-turnstile-response"]'
        ) as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.value = token;
        }
        doc.turnstileCallback?.(token);
      }, solution);
      break;

    case "recaptcha-v2":
    case "recaptcha-v3":
      await page.evaluate((token: string) => {
        const doc = globalThis as typeof globalThis & {
          document: Document;
          onRecaptchaSuccess?: (token: string) => void;
        };
        const textarea = doc.document.querySelector(
          '[name="g-recaptcha-response"]'
        ) as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.value = token;
          (textarea as HTMLElement).style.display = "block";
        }
        doc.onRecaptchaSuccess?.(token);
      }, solution);
      break;

    case "hcaptcha":
      await page.evaluate((token: string) => {
        const doc = globalThis as typeof globalThis & {
          document: Document;
          hcaptchaCallback?: (token: string) => void;
        };
        const textarea = doc.document.querySelector(
          '[name="h-captcha-response"]'
        ) as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.value = token;
        }
        const input = doc.document.querySelector(
          '[name="g-recaptcha-response"]'
        ) as HTMLInputElement | null;
        if (input) {
          input.value = token;
        }
        doc.hcaptchaCallback?.(token);
      }, solution);
      break;
  }
}
