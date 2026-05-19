import * as http from 'node:http';

// Helper to wait for ngrok API to be ready
export async function waitForNgrokAPI(maxAttempts = 10, delayMs = 500): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const isReady = await checkNgrokAPIReady();
      if (isReady) {
        return true;
      }
    } catch {
      // API not ready yet
    }

    if (i < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

// Check if ngrok API is responding
function checkNgrokAPIReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:4040/api/tunnels', (res) => {
      res.on('data', () => {}); // Consume data
      res.on('end', () => resolve(res.statusCode === 200));
    });

    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Enhanced delay with ngrok API check
export async function ngrokSafeDelay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  // Also wait for ngrok API to be ready
  await waitForNgrokAPI();
}
