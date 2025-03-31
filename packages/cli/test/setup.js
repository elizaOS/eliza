// Mock process.exit to avoid test termination
process.exit = vi.fn();

// Silence console logs during tests
console.log = vi.fn();
console.error = vi.fn();
console.warn = vi.fn();
console.info = vi.fn();

// Define a global fixtures path
global.FIXTURES_PATH = new URL('./fixtures', import.meta.url).pathname;
