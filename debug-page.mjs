#!/usr/bin/env node
import puppeteer from 'puppeteer';

async function debugPage() {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    console.log('Navigating to http://localhost:5173...');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });

    console.log('Page loaded. Checking for elements...');

    // Check if app-sidebar exists
    const sidebarExists = await page.$('[data-testid="app-sidebar"]') !== null;
    console.log('app-sidebar exists:', sidebarExists);

    // Check if connection-status exists  
    const connectionExists = await page.$('[data-testid="connection-status"]') !== null;
    console.log('connection-status exists:', connectionExists);

    // Check if mobile-menu-button exists
    const mobileButtonExists = await page.$('[data-testid="mobile-menu-button"]') !== null;
    console.log('mobile-menu-button exists:', mobileButtonExists);

    // Get page title
    const title = await page.title();
    console.log('Page title:', title);

    // Get root element content length
    const rootHtml = await page.evaluate(() => {
        const root = document.getElementById('root');
        return root ? root.innerHTML.length : 0;
    });
    console.log('Root element HTML length:', rootHtml);

    // Take screenshot
    await page.screenshot({ path: 'debug-page.png', fullPage: true });
    console.log('Screenshot saved as debug-page.png');

    await browser.close();
}

debugPage().catch(console.error);
