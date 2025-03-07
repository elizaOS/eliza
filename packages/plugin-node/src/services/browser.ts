import { type IAgentRuntime, type IBrowserService, logger, ModelTypes, parseJSONObjectFromText, Service, type ServiceType, ServiceTypes, settings, stringToUuid, trimTokens } from "@elizaos/core";
import CaptchaSolver from "capsolver-npm";
import {
    type Browser,
    type BrowserContext,
    chromium,
    type Page,
} from "patchright";

async function generateSummary(
    runtime: IAgentRuntime,
    text: string
): Promise<{ title: string; description: string }> {
    // make sure text is under 128k characters
    text = await trimTokens(text, 100000, runtime);

    const prompt = `Please generate a concise summary for the following text:

  Text: """
  ${text}
  """

  Respond with a JSON object in the following format:
  \`\`\`json
  {
    "title": "Generated Title",
    "summary": "Generated summary and/or description of the text"
  }
  \`\`\``;

    const response = await runtime.useModel(ModelTypes.TEXT_SMALL, {
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

type PageContent = {
    title: string;
    description: string;
    bodyContent: string;
};

export class BrowserService extends Service implements IBrowserService {
    private browser: Browser | undefined;
    private context: BrowserContext | undefined;
    private captchaSolver: CaptchaSolver;
    private cacheKey = "content/browser";

    static serviceType: ServiceType = ServiceTypes.BROWSER;
    capabilityDescription = "The agent is able to browse the web and fetch content";

    constructor(runtime: IAgentRuntime) {
        super();
        this.runtime = runtime;
        this.browser = undefined;
        this.context = undefined;
        this.captchaSolver = new CaptchaSolver(
            settings.CAPSOLVER_API_KEY || ""
        );
    }

    static async start(runtime: IAgentRuntime): Promise<BrowserService> {
        const service = new BrowserService(runtime);
        await service.initializeBrowser();
        return service;
    }

    static async stop(runtime: IAgentRuntime) {
        const service = runtime.getService(ServiceTypes.BROWSER);
        if (service) {
            await service.stop();
        }
    }

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
            let userAgent = "";

            // Change the user agent to match the platform to reduce bot detection
            switch (platform) {
                case "darwin":
                    userAgent =
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
                    break;
                case "win32":
                    userAgent =
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
                    break;
                case "linux":
                    userAgent =
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
                    break;
                default:
                    userAgent =
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
            }

            this.context = await this.browser.newContext({
                userAgent,
                acceptDownloads: false,
            });

        }
    }

    async stop() {
        if (this.context) {
            await this.context.close();
            this.context = undefined;
        }
        if (this.browser) {
            await this.browser.close();
            this.browser = undefined;
        }
    }

    async getPageContent(
        url: string,
        runtime: IAgentRuntime
    ): Promise<PageContent> {
        await this.initializeBrowser();
        return await this.fetchPageContent(url, runtime);
    }

    private getCacheKey(url: string): string {
        return stringToUuid(url);
    }

    private async fetchPageContent(
        url: string,
        runtime: IAgentRuntime
    ): Promise<PageContent> {
        const cacheKey = this.getCacheKey(url);
        const cached = await runtime.getDatabaseAdapter().getCache<any>(`${this.cacheKey}/${cacheKey}`);

        if (cached) {
            return cached.content;
        }

        let page: Page | undefined;

        try {
            if (!this.context) {
                logger.log(
                    "Browser context not initialized. Call initializeBrowser() first."
                );
            }

            page = await this.context.newPage();

            // Enable stealth mode
            await page.setExtraHTTPHeaders({
                "Accept-Language": "en-US,en;q=0.9",
            });

            const response = await page.goto(url, { waitUntil: "networkidle" });

            if (!response) {
                logger.error("Failed to load the page");
            }

            if (response.status() === 403 || response.status() === 404) {
                return await this.tryAlternativeSources(url, runtime);
            }

            // Check for CAPTCHA
            const captchaDetected = await this.detectCaptcha(page);
            if (captchaDetected) {
                await this.solveCaptcha(page, url);
            }
            const documentTitle = await page.evaluate(() => document.title);
            const bodyContent = await page.evaluate(
                () => document.body.innerText
            );
            const { title: parsedTitle, description } = await generateSummary(
                runtime,
                `${documentTitle}\n${bodyContent}`
            );
            const content = { title: parsedTitle, description, bodyContent };
            await runtime.getDatabaseAdapter().setCache<any>(`${this.cacheKey}/${cacheKey}`, {
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
                    document.getElementById("g-recaptcha-response").innerHTML =
                        token;
                }, solution.gRecaptchaResponse);
            }
        } catch (error) {
            logger.error("Error solving CAPTCHA:", error);
        }
    }

    private async getHCaptchaWebsiteKey(page: Page): Promise<string> {
        return page.evaluate(() => {
            const hcaptchaIframe = document.querySelector(
                'iframe[src*="hcaptcha.com"]'
            );
            if (hcaptchaIframe) {
                const src = hcaptchaIframe.getAttribute("src");
                const match = src?.match(/sitekey=([^&]*)/);
                return match ? match[1] : "";
            }
            return "";
        });
    }

    private async getReCaptchaWebsiteKey(page: Page): Promise<string> {
        return page.evaluate(() => {
            const recaptchaElement = document.querySelector(".g-recaptcha");
            return recaptchaElement
                ? recaptchaElement.getAttribute("data-sitekey") || ""
                : "";
        });
    }

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
            const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(
                url
            )}`;
            try {
                return await this.fetchPageContent(googleSearchUrl, runtime);
            } catch (error) {
                logger.error("Error fetching from Google Search:", error);
                logger.error(
                    "Failed to fetch content from alternative sources"
                );
                return {
                    title: url,
                    description:
                        "Error, could not fetch content from alternative sources",
                    bodyContent: "",
                };
            }
        }
    }
}
