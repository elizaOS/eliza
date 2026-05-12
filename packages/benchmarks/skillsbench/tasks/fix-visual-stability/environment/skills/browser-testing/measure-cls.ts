import { chromium } from 'playwright';

interface CLSResult {
  url: string;
  cls: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  metrics: Record<string, number>;
}

async function measureCLS(url: string, scroll: boolean = false): Promise<CLSResult> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const client = await page.context().newCDPSession(page);

  // Enable Performance domain
  await client.send('Performance.enable');

  // Navigate and wait for load
  await page.goto(url, { waitUntil: 'networkidle' });

  // Optional: scroll to trigger lazy-loaded content shifts
  if (scroll) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
  }

  // Wait for any remaining shifts
  await page.waitForTimeout(2000);

  // Get all metrics including CumulativeLayoutShift
  const perfMetrics = await client.send('Performance.getMetrics');

  await browser.close();

  // Convert metrics array to object
  const metrics: Record<string, number> = {};
  for (const m of perfMetrics.metrics) {
    metrics[m.name] = m.value;
  }

  // CLS is directly available from CDP
  const cls = metrics['CumulativeLayoutShift'] || 0;

  // Determine rating (Google's thresholds)
  let rating: 'good' | 'needs-improvement' | 'poor';
  if (cls < 0.1) {
    rating = 'good';
  } else if (cls < 0.25) {
    rating = 'needs-improvement';
  } else {
    rating = 'poor';
  }

  return {
    url,
    cls: Math.round(cls * 1000) / 1000,
    rating,
    metrics
  };
}

// Main
const url = process.argv[2] || 'http://localhost:3000';
const scroll = process.argv.includes('--scroll');

measureCLS(url, scroll)
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(err => {
    console.error('CLS measurement failed:', err.message);
    process.exit(1);
  });
