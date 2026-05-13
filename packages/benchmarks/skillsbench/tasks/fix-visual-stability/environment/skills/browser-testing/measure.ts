import { chromium } from 'playwright';

interface RequestTiming {
  url: string;
  start: number;
  end?: number;
}

interface MeasurementResult {
  url: string;
  totalMs: number;
  requests: { url: string; ms: number | null }[];
  metrics: Record<string, number>;
}

async function measure(url: string): Promise<MeasurementResult> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Create CDP session for low-level access
  const client = await page.context().newCDPSession(page);

  // Enable CDP domains we need
  await client.send('Performance.enable');
  await client.send('Network.enable');

  // Track network requests with timestamps
  const requests: RequestTiming[] = [];

  // Network.requestWillBeSent fires when browser is about to send a request
  // We record the URL and start timestamp to build the waterfall
  client.on('Network.requestWillBeSent', (event) => {
    requests.push({
      url: event.request.url,
      start: event.timestamp,
    });
  });

  // Network.responseReceived fires when response headers arrive
  // We find the matching request and record when it completed
  client.on('Network.responseReceived', (event) => {
    const req = requests.find(r => r.url === event.response.url && !r.end);
    if (req) {
      req.end = event.timestamp;
    }
  });

  // Measure total page load time
  const start = Date.now();
  await page.goto(url, { waitUntil: 'networkidle' });
  const totalMs = Date.now() - start;

  // Performance.getMetrics returns Chrome's internal performance counters:
  // - JSHeapUsedSize: Memory used by JavaScript objects
  // - LayoutCount: Number of layout recalculations (high = layout thrashing)
  // - RecalcStyleCount: Number of style recalculations
  // - ScriptDuration: Total time spent executing JavaScript
  // - TaskDuration: Total time spent on main thread tasks
  const perfMetrics = await client.send('Performance.getMetrics');

  await browser.close();

  // Convert timestamps to milliseconds duration
  const requestTimings = requests.map(r => ({
    url: r.url,
    ms: r.end ? (r.end - r.start) * 1000 : null,
  }));

  // Convert metrics array to object for easier reading
  const metrics: Record<string, number> = {};
  for (const m of perfMetrics.metrics) {
    metrics[m.name] = m.value;
  }

  return {
    url,
    totalMs,
    requests: requestTimings,
    metrics,
  };
}

// Main
const url = process.argv[2] || 'http://localhost:3000';
measure(url)
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(err => {
    console.error('Measurement failed:', err.message);
    process.exit(1);
  });
