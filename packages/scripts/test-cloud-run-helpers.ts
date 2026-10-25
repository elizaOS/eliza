const GITHUB_LOG_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/;

function stripAnsi(input) {
  let result = "";
  for (let index = 0; index < input.length; index += 1) {
    if (input.charCodeAt(index) !== 27 || input[index + 1] !== "[") {
      result += input[index];
      continue;
    }

    index += 2;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (code >= 64 && code <= 126) break;
      index += 1;
    }
  }
  return result;
}

function getSummaryLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).replace(GITHUB_LOG_TIMESTAMP_PATTERN, ""));
}

export function getBunFailCounts(output) {
  return getSummaryLines(output)
    .map((line) => line.match(/^\s*(\d+)\s+fail\b/))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]));
}

export function hasBunRunSummary(output) {
  return getSummaryLines(output).some((line) =>
    /^Ran \d+ tests? across \d+ files?\./.test(line),
  );
}

export function hasBunPassRecord(output) {
  return getSummaryLines(output).some((line) => /^\s*\(pass\)\s+/.test(line));
}

export function hasBunFailureMarker(output) {
  return getSummaryLines(output).some((line) => {
    if (/^\s*\(fail\)\s+/.test(line)) return true;
    if (/^# Unhandled error between tests/.test(line)) return true;
    if (/^error: Cannot find (module|package)\b/.test(line)) return true;
    return /^error: Module not found\b/.test(line);
  });
}

export function shouldNormalizeBunStatus99({ status, signal, output }) {
  if (signal) return false;

  const statusIsKnownExitCodePollution = status === 99;
  const statusIsGreenButDirtyExit = status === 1;
  if (!statusIsKnownExitCodePollution && !statusIsGreenButDirtyExit)
    return false;

  const failCounts = getBunFailCounts(output);
  if (failCounts.some((count) => count !== 0)) {
    return false;
  }

  if (hasBunFailureMarker(output)) return false;

  return (
    hasBunRunSummary(output) ||
    (statusIsGreenButDirtyExit && hasBunPassRecord(output))
  );
}
