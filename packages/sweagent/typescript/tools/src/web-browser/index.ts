#!/usr/bin/env node

/**
 * Web browser tool
 * Provides browser automation capabilities
 * Simplified version - full implementation would use Playwright
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import express from "express";
import { type Browser, chromium, type Page } from "playwright";

class BrowserManager {
  private browser?: Browser;
  private page?: Page;
  private screenshotDir = "/tmp/browser-screenshots";
  private isHeadless = process.env.WEB_BROWSER_HEADLESS !== "0";

  constructor() {
    // Ensure screenshot directory exists
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  async init(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.isHeadless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      const context = await this.browser.newContext({
        viewport: { width: 1024, height: 768 },
      });
      this.page = await context.newPage();
    }
  }

  async openSite(url: string): Promise<void> {
    await this.init();
    if (!this.page) throw new Error("Browser not initialized");

    // Handle local files
    if (fs.existsSync(url)) {
      url = `file://${path.resolve(url)}`;
    }

    await this.page.goto(url, { waitUntil: "load" });
    console.log(`Navigated to ${url}`);
    console.log(`Page title: ${await this.page.title()}`);
  }

  async closeSite(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
      this.page = undefined;
      console.log("Browser closed");
    }
  }

  async screenshot(filename?: string): Promise<void> {
    if (!this.page) {
      console.error("No page open");
      return;
    }

    const screenshotPath = path.join(
      this.screenshotDir,
      filename || `screenshot-${Date.now()}.png`,
    );

    await this.page.screenshot({ path: screenshotPath, fullPage: true });

    // Convert to base64 for markdown display
    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64 = imageBuffer.toString("base64");
    console.log(`![Screenshot](data:image/png;base64,${base64})`);
  }

  async click(
    x: number,
    y: number,
    button: "left" | "right" = "left",
  ): Promise<void> {
    if (!this.page) {
      console.error("No page open");
      return;
    }

    await this.page.mouse.click(x, y, { button });
    console.log(`Clicked at (${x}, ${y}) with ${button} button`);
  }

  async type(text: string): Promise<void> {
    if (!this.page) {
      console.error("No page open");
      return;
    }

    await this.page.keyboard.type(text);
    console.log(`Typed: ${text}`);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    if (!this.page) {
      console.error("No page open");
      return;
    }

    await this.page.mouse.wheel(deltaX, deltaY);
    console.log(`Scrolled by (${deltaX}, ${deltaY})`);
  }

  async executeScript(script: string): Promise<void> {
    if (!this.page) {
      console.error("No page open");
      return;
    }

    const result = await this.page.evaluate(script);
    console.log("Script executed. Result:", result);
  }

  async getConsoleOutput(): Promise<void> {
    if (!this.page) {
      console.error("No page open");
      return;
    }

    // Set up console listener
    this.page.on("console", (msg: import("playwright").ConsoleMessage) => {
      console.log(`[Console ${msg.type()}]: ${msg.text()}`);
    });

    console.log("Console output listener activated");
  }
}

// Web server for browser control (simplified)
class BrowserServer {
  private app: express.Application;
  private browserManager: BrowserManager;
  private port: number;

  constructor(port: number = 8009) {
    this.port = port;
    this.app = express();
    this.browserManager = new BrowserManager();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    this.app.post("/goto", async (req, res) => {
      try {
        await this.browserManager.openSite(req.body.url);
        res.json({ status: "success" });
      } catch (error) {
        res.status(500).json({ status: "error", message: String(error) });
      }
    });

    this.app.post("/close", async (_req, res) => {
      try {
        await this.browserManager.closeSite();
        res.json({ status: "success" });
      } catch (error) {
        res.status(500).json({ status: "error", message: String(error) });
      }
    });

    this.app.get("/screenshot", async (_req, res) => {
      try {
        await this.browserManager.screenshot();
        res.json({ status: "success" });
      } catch (error) {
        res.status(500).json({ status: "error", message: String(error) });
      }
    });

    this.app.post("/click", async (req, res) => {
      try {
        await this.browserManager.click(
          req.body.x,
          req.body.y,
          req.body.button,
        );
        res.json({ status: "success" });
      } catch (error) {
        res.status(500).json({ status: "error", message: String(error) });
      }
    });

    this.app.post("/type", async (req, res) => {
      try {
        await this.browserManager.type(req.body.text);
        res.json({ status: "success" });
      } catch (error) {
        res.status(500).json({ status: "error", message: String(error) });
      }
    });
  }

  start(): void {
    this.app.listen(this.port, () => {
      console.log(`Browser server running on port ${this.port}`);
    });
  }
}

// CLI if run directly
if (require.main === module) {
  program
    .name("web-browser")
    .description("Web browser automation tool")
    .version("1.0.0");

  program
    .command("server")
    .description("Start the browser server")
    .option("-p, --port <port>", "Server port", "8009")
    .action((options) => {
      const server = new BrowserServer(parseInt(options.port, 10));
      server.start();
    });

  program
    .command("open <url>")
    .description("Open a URL")
    .action(async (url) => {
      const manager = new BrowserManager();
      await manager.openSite(url);
      await manager.closeSite();
    });

  program
    .command("screenshot <url>")
    .description("Take a screenshot of a URL")
    .action(async (url) => {
      const manager = new BrowserManager();
      await manager.openSite(url);
      await manager.screenshot();
      await manager.closeSite();
    });

  program.parse(process.argv);
}

export { BrowserManager, BrowserServer };
