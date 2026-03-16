import { type IAgentRuntime, type TestSuite, logger } from "@elizaos/core";
import puppeteer, { Browser, Page } from "puppeteer";
import { EnhancedSecretManager } from "../enhanced-service";
import { NgrokService } from "../services/ngrok-service";
import { SecretFormService } from "../services/secret-form-service";
import type { SecretContext } from "../types";

/**
 * E2E Test Suite for Secret Form functionality
 * Tests form creation, ngrok tunnels, form submission, and secret storage
 */
export const secretFormsSuite: TestSuite = {
  name: "Secret Forms E2E Tests",

  tests: [
    {
      name: "Create and Submit Basic Secret Form",
      async fn(runtime: IAgentRuntime): Promise<void> {
        let browser: Browser | null = null;
        let page: Page | null = null;

        try {
          // Get services
          const formService = runtime.getService(
            "SECRET_FORMS",
          ) as SecretFormService;
          const secretsManager = runtime.getService(
            "SECRETS",
          ) as EnhancedSecretManager;

          if (!formService || !secretsManager) {
            throw new Error("Required services not available");
          }

          // Create form request
          const request = {
            secrets: [
              {
                key: "TEST_API_KEY",
                config: {
                  type: "api_key" as const,
                  description: "Test API Key",
                  required: true,
                  encrypted: true,
                },
              },
            ],
            title: "Test Secret Form",
            mode: "requester" as const,
            expiresIn: 5 * 60 * 1000, // 5 minutes
          };

          const context: SecretContext = {
            level: "user",
            userId: "test-user-123",
            agentId: runtime.agentId,
            requesterId: runtime.agentId,
          };

          let submissionReceived = false;
          let submittedValue: string | null = null;

          // Create form with callback
          const { url, sessionId } = await formService.createSecretForm(
            request,
            context,
            async (submission) => {
              submissionReceived = true;
              submittedValue = submission.data.TEST_API_KEY;
            },
          );

          // Verify form was created
          if (!url || !sessionId) {
            throw new Error("Form creation failed");
          }

          logger.info(`[E2E Test] Form created: ${url}`);

          // Launch browser and navigate to form
          browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
          });

          page = await browser.newPage();
          await page.goto(url, { waitUntil: "networkidle2" });

          // Wait for form to load
          await page.waitForSelector("#secretForm", { timeout: 10000 });

          // Fill out the form
          const testApiKey = "sk-test-" + Date.now();
          await page.type("#TEST_API_KEY", testApiKey);

          // Submit form
          await page.click('button[type="submit"]');

          // Wait for success message
          await page.waitForSelector("#successMessage:not(.hidden)", {
            timeout: 10000,
          });

          // Wait a bit for callback to be called
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Verify submission was received
          if (!submissionReceived || submittedValue !== testApiKey) {
            throw new Error("Form submission not received correctly");
          }

          // Verify secret was stored
          const storedValue = await secretsManager.get("TEST_API_KEY", context);
          if (storedValue !== testApiKey) {
            throw new Error("Secret not stored correctly");
          }
        } catch (error) {
          logger.error("[E2E Test] Error:", error);
          throw error;
        } finally {
          // Cleanup
          if (page) await page.close();
          if (browser) await browser.close();
        }
      },
    },

    {
      name: "Test Form Expiration",
      async fn(runtime: IAgentRuntime): Promise<void> {
        try {
          const formService = runtime.getService(
            "SECRET_FORMS",
          ) as SecretFormService;

          // Create form with short expiration
          const request = {
            secrets: [
              {
                key: "EXPIRING_SECRET",
                config: {
                  type: "secret" as const,
                  description: "Expiring Secret",
                  required: true,
                },
              },
            ],
            title: "Expiring Form",
            expiresIn: 100, // 100ms - very short for testing
          };

          const context: SecretContext = {
            level: "user",
            userId: "test-user-expire",
            agentId: runtime.agentId,
            requesterId: runtime.agentId,
          };

          const { sessionId } = await formService.createSecretForm(
            request,
            context,
          );

          // Wait for form to expire
          await new Promise((resolve) => setTimeout(resolve, 200));

          // Check session status
          const session = formService.getSession(sessionId);
          if (session && session.status === "active") {
            throw new Error("Form should have expired");
          }
        } catch (error) {
          throw error;
        }
      },
    },

    {
      name: "Test Multiple Secret Fields",
      async fn(runtime: IAgentRuntime): Promise<void> {
        let browser: Browser | null = null;
        let page: Page | null = null;

        try {
          const formService = runtime.getService(
            "SECRET_FORMS",
          ) as SecretFormService;
          const secretsManager = runtime.getService(
            "SECRETS",
          ) as EnhancedSecretManager;

          // Create form with multiple fields
          const request = {
            secrets: [
              {
                key: "OPENAI_KEY",
                config: {
                  type: "api_key" as const,
                  description: "OpenAI API Key",
                  required: true,
                },
              },
              {
                key: "WEBHOOK_URL",
                config: {
                  type: "url" as const,
                  description: "Webhook URL",
                  required: true,
                },
              },
              {
                key: "CONFIG_JSON",
                config: {
                  type: "config" as const,
                  description: "JSON Configuration",
                  required: false,
                },
              },
            ],
            title: "Multiple Secrets Form",
          };

          const context: SecretContext = {
            level: "user",
            userId: "test-user-multi",
            agentId: runtime.agentId,
            requesterId: runtime.agentId,
          };

          const { url } = await formService.createSecretForm(request, context);

          // Launch browser and fill form
          browser = await puppeteer.launch({ headless: true });
          page = await browser.newPage();
          await page.goto(url, { waitUntil: "networkidle2" });

          // Fill multiple fields
          await page.type("#OPENAI_KEY", "sk-openai-test-123");
          await page.type("#WEBHOOK_URL", "https://example.com/webhook");
          await page.type("#CONFIG_JSON", '{"test": true}');

          // Submit
          await page.click('button[type="submit"]');
          await page.waitForSelector("#successMessage:not(.hidden)", {
            timeout: 10000,
          });

          // Wait for storage
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Verify all secrets were stored
          const openaiKey = await secretsManager.get("OPENAI_KEY", context);
          const webhookUrl = await secretsManager.get("WEBHOOK_URL", context);
          const configJson = await secretsManager.get("CONFIG_JSON", context);

          if (
            openaiKey !== "sk-openai-test-123" ||
            webhookUrl !== "https://example.com/webhook" ||
            configJson !== '{"test": true}'
          ) {
            throw new Error("Not all secrets were stored correctly");
          }
        } catch (error) {
          throw error;
        } finally {
          if (page) await page.close();
          if (browser) await browser.close();
        }
      },
    },

    {
      name: "Test Form Validation",
      async fn(runtime: IAgentRuntime): Promise<void> {
        let browser: Browser | null = null;
        let page: Page | null = null;

        try {
          const formService = runtime.getService(
            "SECRET_FORMS",
          ) as SecretFormService;

          // Create form with validation
          const request = {
            secrets: [
              {
                key: "API_KEY_VALIDATED",
                config: {
                  type: "api_key" as const,
                  description: "API Key (min 10 chars)",
                  required: true,
                },
              },
            ],
            title: "Validation Test Form",
          };

          const context: SecretContext = {
            level: "user",
            userId: "test-user-validation",
            agentId: runtime.agentId,
            requesterId: runtime.agentId,
          };

          const { url } = await formService.createSecretForm(request, context);

          browser = await puppeteer.launch({ headless: true });
          page = await browser.newPage();
          await page.goto(url, { waitUntil: "networkidle2" });

          // Try to submit empty form
          await page.click('button[type="submit"]');

          // Check for HTML5 validation message
          const validationMessage = await page.evaluate(() => {
            const input = document.getElementById(
              "API_KEY_VALIDATED",
            ) as HTMLInputElement;
            return input?.validationMessage;
          });

          if (!validationMessage) {
            throw new Error("Form validation not working");
          }
        } catch (error) {
          throw error;
        } finally {
          if (page) await page.close();
          if (browser) await browser.close();
        }
      },
    },

    {
      name: "Test Ngrok Tunnel Management",
      async fn(runtime: IAgentRuntime): Promise<void> {
        try {
          const ngrokService = runtime.getService("NGROK") as NgrokService;
          const formService = runtime.getService(
            "SECRET_FORMS",
          ) as SecretFormService;

          // Get initial tunnel count
          const initialTunnels = ngrokService.getActiveTunnels().length;

          // Create a form (which creates a tunnel)
          const request = {
            secrets: [
              {
                key: "TUNNEL_TEST_SECRET",
                config: {
                  type: "secret" as const,
                  description: "Tunnel Test",
                  required: true,
                },
              },
            ],
            title: "Tunnel Test Form",
          };

          const context: SecretContext = {
            level: "user",
            userId: "test-user-tunnel",
            agentId: runtime.agentId,
            requesterId: runtime.agentId,
          };

          const { sessionId } = await formService.createSecretForm(
            request,
            context,
          );

          // Verify tunnel was created
          const activeTunnels = ngrokService.getActiveTunnels();
          if (activeTunnels.length <= initialTunnels) {
            throw new Error("Tunnel was not created");
          }

          // Close the session
          await formService.closeSession(sessionId);

          // Verify tunnel was cleaned up
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const finalTunnels = ngrokService.getActiveTunnels().length;

          if (finalTunnels !== initialTunnels) {
            throw new Error("Tunnel was not cleaned up");
          }
        } catch (error) {
          throw error;
        }
      },
    },
  ],
};
