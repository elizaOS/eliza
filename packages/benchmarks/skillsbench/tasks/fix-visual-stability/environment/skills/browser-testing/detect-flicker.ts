import { chromium } from 'playwright';
import { PNG } from 'pngjs';

interface FlickerResult {
  url: string;
  expectedTheme: string;
  flickerDetected: boolean;
  earlyScreenshot: string;
  finalScreenshot: string;
  earlyBrightness: number;
  finalBrightness: number;
  diagnosis: string;
}

function getAverageBrightness(pngBuffer: Buffer): number {
  const png = PNG.sync.read(pngBuffer);
  let totalBrightness = 0;
  const pixelCount = png.width * png.height;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      // Perceived brightness formula
      totalBrightness += (r * 0.299 + g * 0.587 + b * 0.114);
    }
  }

  return totalBrightness / pixelCount;
}

function isLightImage(brightness: number): boolean {
  return brightness > 150;
}

async function detectFlicker(url: string, expectedTheme: string = 'dark'): Promise<FlickerResult> {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Set theme preference BEFORE page loads
  await context.addInitScript(`localStorage.setItem('theme', '${expectedTheme}');`);

  const page = await context.newPage();

  // Navigate with "commit" to catch earliest paint
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForTimeout(50);

  // Take early screenshot and save
  const earlyPath = '/tmp/flicker-early.png';
  const earlyScreenshot = await page.screenshot({ path: earlyPath });

  // Wait for full load
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);

  // Take final screenshot and save
  const finalPath = '/tmp/flicker-final.png';
  const finalScreenshot = await page.screenshot({ path: finalPath });

  await browser.close();

  // Analyze screenshots
  const earlyBrightness = getAverageBrightness(earlyScreenshot);
  const finalBrightness = getAverageBrightness(finalScreenshot);

  const earlyIsLight = isLightImage(earlyBrightness);
  const finalIsLight = isLightImage(finalBrightness);

  // Flicker detected if:
  // 1. Early and final have different brightness (theme changed during load)
  // 2. OR early doesn't match expected theme
  const themeChanged = earlyIsLight !== finalIsLight;
  const earlyMatchesExpected = expectedTheme === 'dark' ? !earlyIsLight : earlyIsLight;

  let diagnosis: string;
  if (themeChanged) {
    diagnosis = `Theme flicker! Page went from ${earlyIsLight ? 'light' : 'dark'} to ${finalIsLight ? 'light' : 'dark'} during load`;
  } else if (!earlyMatchesExpected) {
    diagnosis = `Wrong initial theme: expected ${expectedTheme} but got ${earlyIsLight ? 'light' : 'dark'} at first paint`;
  } else {
    diagnosis = 'No flicker - correct theme from first paint';
  }

  return {
    url,
    expectedTheme,
    flickerDetected: themeChanged || !earlyMatchesExpected,
    earlyScreenshot: earlyPath,
    finalScreenshot: finalPath,
    earlyBrightness: Math.round(earlyBrightness),
    finalBrightness: Math.round(finalBrightness),
    diagnosis
  };
}

// Main
const url = process.argv[2] || 'http://localhost:3000';
const theme = process.argv[3] || 'dark';

detectFlicker(url, theme)
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(err => {
    console.error('Flicker detection failed:', err.message);
    process.exit(1);
  });
