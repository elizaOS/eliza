// Suppress console output during tests to keep output clean,
// since testing error workflows causes expected error logs.
if (process.env.VERBOSE !== '1') {
  global.console.log = jest.fn();
  global.console.info = jest.fn();
  global.console.warn = jest.fn();
  global.console.error = jest.fn();

  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, fd) => {
    if (typeof chunk === 'string' && chunk.includes('__mcp_event__')) {
      return true;
    }
    return originalStderrWrite(chunk, encoding, fd);
  };
}
