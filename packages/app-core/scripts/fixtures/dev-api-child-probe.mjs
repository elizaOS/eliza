/** Reports the runtime argv and selected environment received by a real child process. */
const keys = [
  "ELIZA_CONTRACT_MARKER",
  "ELIZA_MOCK_GOOGLE_BASE",
  "ELIZA_WALLET_OS_STORE",
  "VITE_ELIZA_IOS_RUNTIME_MODE",
  "VITE_ELIZA_MOBILE_RUNTIME_MODE",
];

const env = Object.fromEntries(
  keys.map((key) => [key, process.env[key] ?? null]),
);
process.stdout.write(
  `${JSON.stringify({ execArgv: process.execArgv, env })}\n`,
);
