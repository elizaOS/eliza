import {
  type IAgentRuntime,
  ModelType,
  Service,
  type ServiceTypeName,
  ServiceType,
  logger,
  parseJSONObjectFromText,
  stringToUuid,
  trimTokens,
} from "@elizaos/core";
// import CaptchaSolver from 'capsolver-npm';
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from "patchright";

// Type for cached content
interface CachedContent {
  url: string;
  content: PageContent;
}

/**
 * Asynchronously generates a summary for a given text using a machine learning model.
 *
 * @param {IAgentRuntime} runtime - The runtime environment for the agent
 * @param {string} text - The text to generate a summary for
 * @returns {Promise<{ title: string; description: string }>} A promise that resolves to an object containing the generated title and summary
 */
async function generateSummary(
  runtime: IAgentRuntime,
  text: string
): Promise<{ title: string; description: string }> {
  // make sure text is under 128k characters
  const trimmedText = await trimTokens(text, 100000, runtime);

  const prompt = `Please generate a concise summary for the following text:
  
    Text: """
    ${trimmedText}
    """
  
    Respond with a JSON object in the following format:
    \`\`\`json
    {
      "title": "Generated Title",
      "summary": "Generated summary and/or description of the text"
    }
    \`\`\``;

  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });

  const parsedResponse = parseJSONObjectFromText(response);

  if (parsedResponse?.title && parsedResponse?.summary) {
    return {
      title: parsedResponse.title,
      description: parsedResponse.summary,
    };
  }

  return {
    title: "",
    description: "",
  };
}

/**
 * Represents the content of a page.
 * @typedef { Object } PageContent
 * @property { string } title - The title of the page.
 * @property { string } description - The description of the page.
 * @property { string } bodyContent - The main content of the page.
 */
type PageContent = {
  title: string;
  description: string;
  bodyContent: string;
};

/**
 * Represents a BrowserService class that extends Service.
 * Provides methods for initializing browser, stopping browser, fetching page content, solving CAPTCHAs, detecting CAPTCHAs, and getting cache key.
 * @extends Service
 */
export class BrowserService extends Service {
  private browser: Browser | undefined;
  private contexts: Record<string, BrowserContext> = {};
  // private captchaSolver: CaptchaSolver;
  private cacheKey = "content/browser";
  private userAgent: string = "";

  static serviceType: ServiceTypeName = ServiceType.BROWSER;
  capabilityDescription =
    "The agent is able to browse the web and fetch content";

  /**
   * Constructor for the Agent class.
   * @param {IAgentRuntime} runtime - The runtime object for the agent.
   */
  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    this.browser = undefined;
    // this.captchaSolver = new CaptchaSolver(runtime.getSetting('CAPSOLVER_API_KEY') || '');
  }

  /**
   * Starts the BrowserService asynchronously.
   *
   * @param {IAgentRuntime} runtime - The runtime for the agent.
   * @returns {Promise<BrowserService>} A promise that resolves to the initialized BrowserService.
   */
  static async start(runtime: IAgentRuntime): Promise<BrowserService> {
    const service = new BrowserService(runtime);
    await service.initializeBrowser();
    return service;
  }

  /**
   * Function to stop the browser service asynchronously.
   *
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(ServiceType.BROWSER);
    if (service) {
      await service.stop();
    }
  }

  /**
   * Initializes the browser by launching Chromium with specified options and setting the user agent based on the platform.
   * @returns {Promise<void>} A promise that resolves once the browser is successfully initialized.
   */
  async initializeBrowser() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-dev-shm-usage", // Uses /tmp instead of /dev/shm. Prevents memory issues on low-memory systems
          "--block-new-web-contents", // Prevents creation of new windows/tabs
        ],
      });

      const platform = process.platform;

      // Change the user agent to match the platform to reduce bot detection
      switch (platform) {
        case "darwin":
          this.userAgent =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
          break;
        case "win32":
          this.userAgent =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
          break;
        case "linux":
          this.userAgent =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
          break;
        default:
          this.userAgent =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
      }

      /*
      this.context = await this.browser.newContext({
        userAgent,
        acceptDownloads: false,
      });
      */
    }
  }

  private async getContext(proxy?: {
    ip: string;
    port: string;
    username?: string;
    password?: string;
  }) {
    let key = "default";
    let proxyOptions:
      | { server: string; username?: string; password?: string }
      | undefined;

    if (proxy) {
      key = `${proxy.ip}:${proxy.port}`;
      console.log("using proxy", key);

      proxyOptions = {
        server: `http://${proxy.ip}:${proxy.port}`,
        username: proxy.username,
        password: proxy.password,
      };
    }

    if (this.contexts[key]) {
      return this.contexts[key];
    }

    const context = await this.browser.newContext({
      userAgent: this.userAgent,
      acceptDownloads: false,
      proxy: proxyOptions,
    });

    this.contexts[key] = context;
    return context;
  }

  /**
   * Asynchronously stops the browser and context if they are currently running.
   */
  async stop() {
    for (const context in this.contexts) {
      await this.contexts[context].close();
      delete this.contexts[context];
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }
  }

  /**
   * Asynchronously fetches the content of a web page.
   *
   * @param {string} url - The URL of the web page to fetch content from.
   * @param {IAgentRuntime} runtime - The runtime environment for the web scraping agent.
   * @returns {Promise<PageContent>} A Promise that resolves with the content of the web page.
   */
  async getPageContent(
    url: string,
    runtime: IAgentRuntime
  ): Promise<PageContent> {
    await this.initializeBrowser();
    return await this.fetchPageContent(url, runtime);
  }

  // needs to be cached externally
  async processPageContent(
    url: string,
    getPrompt: (content: string) => Promise<string>,
    type: "html" | "text" = "html",
    proxies: {
      ip: string;
      port: string;
      login?: string;
      password?: string;
    }[] = []
  ) {
    await this.initializeBrowser();

    let page: Page | undefined;

    for (let i = 0; i < proxies.length; i++) {
      const context = await this.getContext(proxies[i]);

      try {
        if (!context) {
          logger.log(
            "Browser context not initialized. Call initializeBrowser() first."
          );
          throw new Error("Browser context not initialized");
        }

        page = await context.newPage();

        // Enable stealth mode
        await page.setExtraHTTPHeaders({
          "Accept-Language": "en-US,en;q=0.9",
        });

        const response = await page.goto(url, { waitUntil: "networkidle" });

        if (!response) {
          logger.error("Failed to load the page");
          throw new Error("Failed to load the page");
        }

        if (response.status() === 200) {
          break;
        }

        await page.close();
        page = undefined;
      } catch (error) {
        logger.error("Error fetching page content", error);
      }
    }

    try {
      if (!page) {
        throw new Error("Page not initialized");
      }

      const content =
        type === "html"
          ? // @ts-expect-error accesses dom
            await page.evaluate(() => document.body.innerHTML)
          : // @ts-expect-error accesses dom
            await page.evaluate(() => document.body.innerText);

      const prompt = await getPrompt(content);

      return this.runtime.useModel(ModelType.OBJECT_SMALL, {
        prompt,
      });
    } catch (error) {
      logger.error("Error:", error);
      return;
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  /**
   * Generates a cache key for the provided URL by converting it to a UUID string.
   *
   * @param {string} url - The URL for which a cache key is being generated.
   * @returns {string} A UUID string representing the cache key for the URL.
   */
  private getCacheKey(url: string): string {
    return stringToUuid(url);
  }

  /**
   * Fetches the content of a page from the specified URL using a headless browser.
   *
   * @param {string} url - The URL of the page to fetch the content from.
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   * @returns {Promise<PageContent>} A promise that resolves to the content of the fetched page.
   */
  private async fetchPageContent(
    url: string,
    runtime: IAgentRuntime
  ): Promise<PageContent> {
    const cacheKey = this.getCacheKey(url);
    const cached = await runtime.getCache<CachedContent>(
      `${this.cacheKey}/${cacheKey}`
    );

    if (cached) {
      return cached.content;
    }

    let page: Page | undefined;

    try {
      const context = await this.getContext();

      if (!context) {
        logger.log(
          "Browser context not initialized. Call initializeBrowser() first."
        );
        throw new Error("Browser context not initialized");
      }

      page = await context.newPage();

      // Enable stealth mode
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
      });

      const response = await page.goto(url, { waitUntil: "networkidle" });

      if (!response) {
        logger.error("Failed to load the page");
        throw new Error("Failed to load the page");
      }

      if (response.status() === 403 || response.status() === 404) {
        return await this.tryAlternativeSources(url, runtime);
      }

      // Check for CAPTCHA
      // const captchaDetected = await this.detectCaptcha(page);
      //if (captchaDetected) {
      //  await this.solveCaptcha(page, url);
      //}
      // @ts-expect-error accesses dom
      const documentTitle = await page.evaluate(() => document.title);
      // @ts-expect-error accesses dom
      const bodyContent = await page.evaluate(() => document.body.innerText);
      const { title: parsedTitle, description } = await generateSummary(
        runtime,
        `${documentTitle}\n${bodyContent}`
      );
      const content = { title: parsedTitle, description, bodyContent };
      await runtime.setCache<CachedContent>(`${this.cacheKey}/${cacheKey}`, {
        url,
        content,
      });
      return content;
    } catch (error) {
      logger.error("Error:", error);
      return {
        title: url,
        description: "Error, could not fetch content",
        bodyContent: "",
      };
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  /**
   * Detects if a captcha is present on the page based on the specified selectors.
   *
   * @param {Page} page The Puppeteer page to check for captcha.
   * @returns {Promise<boolean>} A boolean indicating whether a captcha was detected.
   */
  private async detectCaptcha(page: Page): Promise<boolean> {
    const captchaSelectors = [
      'iframe[src*="captcha"]',
      'div[class*="captcha"]',
      "#captcha",
      ".g-recaptcha",
      ".h-captcha",
    ];

    for (const selector of captchaSelectors) {
      const element = await page.$(selector);
      if (element) return true;
    }

    return false;
  }

  /**
   * Solves the CAPTCHA challenge on the provided page using either hCaptcha or reCaptcha.
   *
   * @param {Page} page - The page where the CAPTCHA challenge needs to be solved.
   * @param {string} url - The URL of the website with the CAPTCHA challenge.
   * @returns {Promise<void>} - A promise that resolves once the CAPTCHA is solved.
   */
  /*
    private async solveCaptcha(page: Page, url: string): Promise<void> {
      try {
        const hcaptchaKey = await this.getHCaptchaWebsiteKey(page);
        if (hcaptchaKey) {
          const solution = await this.captchaSolver.hcaptchaProxyless({
            websiteURL: url,
            websiteKey: hcaptchaKey,
          });
          await page.evaluate((token) => {
            // eslint-disable-next-line
            // @ts-ignore
            window.hcaptcha.setResponse(token);
          }, solution.gRecaptchaResponse);
          return;
        }
  
        const recaptchaKey = await this.getReCaptchaWebsiteKey(page);
        if (recaptchaKey) {
          const solution = await this.captchaSolver.recaptchaV2Proxyless({
            websiteURL: url,
            websiteKey: recaptchaKey,
          });
          await page.evaluate((token) => {
            // eslint-disable-next-line
            // @ts-ignore
            document.getElementById('g-recaptcha-response').innerHTML = token;
          }, solution.gRecaptchaResponse);
        }
      } catch (error) {
        logger.error('Error solving CAPTCHA:', error);
      }
    }*/

  /**
   * Get the hCaptcha website key from the given Page
   * @param {Page} page - The Page object to extract the hCaptcha website key from
   * @returns {Promise<string>} The hCaptcha website key
   */
  /*
    private async getHCaptchaWebsiteKey(page: Page): Promise<string> {
      return page.evaluate(() => {
        const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
        if (hcaptchaIframe) {
          const src = hcaptchaIframe.getAttribute('src');
          const match = src?.match(/sitekey=([^&]*)/);
          return match ? match[1] : '';
        }
        return '';
      });
    }
      */

  /**
   * Retrieves the ReCaptcha website key from a given page.
   * @param {Page} page - The page to extract the ReCaptcha website key from.
   * @returns {Promise<string>} The ReCaptcha website key, or an empty string if not found.
   */
  /*
    private async getReCaptchaWebsiteKey(page: Page): Promise<string> {
      return page.evaluate(() => {
        const recaptchaElement = document.querySelector('.g-recaptcha');
        return recaptchaElement ? recaptchaElement.getAttribute('data-sitekey') || '' : '';
      });
    }*/

  /**
   * Try fetching content from alternative sources if the original source fails.
   *
   * @param {string} url - The URL of the content to fetch.
   * @param {IAgentRuntime} runtime - The runtime environment.
   * @returns {Promise<{ title: string; description: string; bodyContent: string }>} The fetched content with title, description, and body.
   */
  private async tryAlternativeSources(
    url: string,
    runtime: IAgentRuntime
  ): Promise<{ title: string; description: string; bodyContent: string }> {
    // because this (tryAlternativeSources) calls fetchPageContent
    // and fetchPageContent calls tryAlternativeSources
    // we need these url.matches to progress
    // through the things to try
    if (!url.match(/web.archive.org\/web/)) {
      // Try Internet Archive
      const archiveUrl = `https://web.archive.org/web/${url}`;
      try {
        return await this.fetchPageContent(archiveUrl, runtime);
      } catch (error) {
        logger.error("Error fetching from Internet Archive:", error);
      }
    }

    if (!url.match(/www.google.com\/search/)) {
      // Try Google Search as a last resort
      const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      try {
        return await this.fetchPageContent(googleSearchUrl, runtime);
      } catch (error) {
        logger.error("Error fetching from Google Search:", error);
        logger.error("Failed to fetch content from alternative sources");
      }
    }

    // Return error content if all alternatives fail
    return {
      title: url,
      description: "Error, could not fetch content from alternative sources",
      bodyContent: "",
    };
  }
}
