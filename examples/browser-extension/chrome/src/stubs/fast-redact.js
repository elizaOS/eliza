// Stub for fast-redact - returns a passthrough function
function fastRedact(opts) {
  // Return a function that just returns the input unchanged
  const redact = (obj) => obj;
  redact.restore = (obj) => obj;
  return redact;
}

fastRedact.default = fastRedact;
fastRedact.rx = [];
fastRedact.validator = () => true;

export default fastRedact;
export { fastRedact };
