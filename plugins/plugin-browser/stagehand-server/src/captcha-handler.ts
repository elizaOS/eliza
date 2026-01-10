import { Page } from 'playwright';

export interface CaptchaInfo {
  type: 'turnstile' | 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | null;
  siteKey: string | null;
}

export async function detectCaptchaType(page: Page): Promise<CaptchaInfo> {
  try {
    // Check for Cloudflare Turnstile
    const turnstileElement = await page.$('[id*="turnstile"], [class*="cf-turnstile"]');
    if (turnstileElement) {
      const siteKey = await page.evaluate(() => {
        const element = document.querySelector('[data-sitekey]') as HTMLElement;
        return element?.dataset.sitekey || null;
      });
      return { type: 'turnstile', siteKey };
    }

    // Check for reCAPTCHA v2
    const recaptchaV2Element = await page.$('.g-recaptcha, [data-sitekey]');
    if (recaptchaV2Element) {
      const siteKey = await page.evaluate(() => {
        const element = document.querySelector('[data-sitekey]') as HTMLElement;
        return element?.dataset.sitekey || null;
      });
      return { type: 'recaptcha-v2', siteKey };
    }

    // Check for reCAPTCHA v3
    const hasRecaptchaV3 = await page.evaluate(() => {
      return !!(window as any).grecaptcha?.execute;
    });
    if (hasRecaptchaV3) {
      const siteKey = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha"]'));
        for (const script of scripts) {
          const match = (script as HTMLScriptElement).src.match(/render=([^&]+)/);
          if (match) return match[1];
        }
        return null;
      });
      return { type: 'recaptcha-v3', siteKey };
    }

    // Check for hCaptcha
    const hcaptchaElement = await page.$('.h-captcha, [data-hcaptcha-widget-id]');
    if (hcaptchaElement) {
      const siteKey = await page.evaluate(() => {
        const element = document.querySelector('[data-sitekey]') as HTMLElement;
        return element?.dataset.sitekey || null;
      });
      return { type: 'hcaptcha', siteKey };
    }

    return { type: null, siteKey: null };
  } catch (error) {
    console.error('Error detecting captcha type:', error);
    return { type: null, siteKey: null };
  }
}

export async function injectCaptchaSolution(
  page: Page,
  captchaType: string,
  solution: string
): Promise<void> {
  // This is a placeholder - actual implementation would depend on captcha type
  // For now, we'll just log that we would inject the solution
  console.log(`Would inject ${captchaType} solution:`, solution.substring(0, 20) + '...');
}
