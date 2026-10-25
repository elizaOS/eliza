// Stub for node-llama-cpp — the real package is a native optional dep with no
// dist/ on this machine. Tests never actually call loadBinding() because the
// local inference service is mocked, so this empty module suffices.
export default {};
