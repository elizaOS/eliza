// Mock process.exit to avoid test termination
process.exit = jest.fn();

// Silence console logs during tests
console.log = jest.fn();
console.error = jest.fn();
console.warn = jest.fn();
console.info = jest.fn();

// Define a global fixtures path
global.FIXTURES_PATH = new URL('./fixtures', import.meta.url).pathname;
