/**
 * Defines the fail-closed command-line contract shared by AI-QA reviewer
 * entrypoints before they inspect credentials, call a model, or write evidence.
 */

function requireUnique(seen, argument) {
  if (seen.has(argument)) {
    throw new Error(`${argument} may be specified only once`);
  }
  seen.add(argument);
}

function takeValue(argv, index, argument) {
  const value = argv[index + 1];
  const isNegativeConcurrency =
    argument === "--concurrency" && /^-\d/u.test(value ?? "");
  if (!value || (value.startsWith("-") && !isNegativeConcurrency)) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

export function parseReviewerArgs(argv, { defaultVerdictMd } = {}) {
  const supportsVerdictMd = defaultVerdictMd !== undefined;
  const options = {
    runDir: null,
    concurrency: 4,
    strict: false,
    ...(supportsVerdictMd ? { verdictMd: defaultVerdictMd } : {}),
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") {
      requireUnique(seen, argument);
      options.strict = true;
      continue;
    }
    if (
      argument === "--run-dir" ||
      argument === "--concurrency" ||
      (supportsVerdictMd && argument === "--verdict-md")
    ) {
      requireUnique(seen, argument);
      const value = takeValue(argv, index, argument);
      index += 1;
      if (argument === "--run-dir") {
        options.runDir = value;
      } else if (argument === "--verdict-md") {
        options.verdictMd = value;
      } else {
        const concurrency = Number(value);
        if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
          throw new Error(
            `--concurrency must be a positive safe integer (received ${JSON.stringify(value)})`,
          );
        }
        options.concurrency = concurrency;
      }
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return options;
}
