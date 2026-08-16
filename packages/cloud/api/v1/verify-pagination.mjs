import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routeFiles = [
  "billing/ledger/route.ts",
  "ballots/route.ts",
  "oauth-intents/route.ts",
  "gallery/route.ts",
];

function parsePaginationParam(rawValue, parameter, defaultValue) {
  const value = rawValue?.trim();
  if (!value) return defaultValue;

  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return `Invalid ${parameter} ${JSON.stringify(rawValue)}: expected a canonical decimal integer`;
  }

  const parsed = Number(value);
  const maximum = parameter === "limit" ? 500 : Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (parameter === "limit" ? 1 : 0) ||
    parsed > maximum
  ) {
    const bounds =
      parameter === "limit"
        ? "between 1 and 500"
        : "greater than or equal to 0";
    return `Invalid ${parameter} ${JSON.stringify(rawValue)}: expected an integer ${bounds}`;
  }

  return parsed;
}

assert.equal(parsePaginationParam(undefined, "limit", 50), 50);
assert.equal(parsePaginationParam("", "limit", 50), 50);
assert.equal(parsePaginationParam("   ", "offset", 0), 0);
assert.equal(parsePaginationParam(" 37 ", "limit", 50), 37);
assert.equal(parsePaginationParam("0", "offset", 0), 0);
assert.equal(parsePaginationParam("500", "limit", 50), 500);
assert.equal(
  parsePaginationParam("9007199254740991", "offset", 0),
  9007199254740991,
);

for (const value of ["0", "-1", "+1", "1.5", "1e2", "007", "501", "12px"]) {
  const result = parsePaginationParam(value, "limit", 50);
  assert.equal(
    typeof result,
    "string",
    `limit ${JSON.stringify(value)} must fail`,
  );
  assert.match(result, /limit/);
  assert.ok(result.includes(value));
}
for (const value of [
  "-1",
  "+1",
  "1.5",
  "1e2",
  "007",
  "12px",
  "9007199254740992",
]) {
  const result = parsePaginationParam(value, "offset", 0);
  assert.equal(
    typeof result,
    "string",
    `offset ${JSON.stringify(value)} must fail`,
  );
  assert.match(result, /offset/);
  assert.ok(result.includes(value));
}

const forbiddenPatterns = [
  [/Number\s*\(\s*c\.req\.query/, "unguarded Number(c.req.query"],
  [/parseInt\s*\(\s*c\.req\.query/, "unguarded parseInt(c.req.query"],
  [/z\.coerce\.number/, "z.coerce.number pagination coercion"],
];

for (const file of routeFiles) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(
    source,
    /function parsePaginationParam\(/,
    `${file}: parser missing`,
  );
  assert.match(
    source,
    /\^\(\?:0\|\[1-9\]\\d\*\)\$/,
    `${file}: canonical grammar missing`,
  );
  assert.match(
    source,
    /Number\.isSafeInteger\(parsed\)/,
    `${file}: safe-integer guard missing`,
  );
  assert.match(
    source,
    /parameter === "limit" \? 500/,
    `${file}: limit ceiling missing`,
  );

  for (const [pattern, description] of forbiddenPatterns) {
    assert.doesNotMatch(source, pattern, `${file}: ${description} remains`);
  }
}

const billing = readFileSync(
  new URL("billing/ledger/route.ts", import.meta.url),
  "utf8",
);
assert.match(
  billing,
  /parsePaginationParam\(c\.req\.query\("limit"\), "limit", 50\)/,
);

for (const file of ["ballots/route.ts", "oauth-intents/route.ts"]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(
    source,
    /parsePaginationParam\(c\.req\.query\("limit"\), "limit", 50\)/,
  );
  assert.match(
    source,
    /parsePaginationParam\(c\.req\.query\("offset"\), "offset", 0\)/,
  );
}

const gallery = readFileSync(
  new URL("gallery/route.ts", import.meta.url),
  "utf8",
);
assert.match(
  gallery,
  /parsePaginationParam\(c\.req\.query\("limit"\), "limit", 100\)/,
);
assert.match(
  gallery,
  /parsePaginationParam\(c\.req\.query\("offset"\), "offset", 0\)/,
);
assert.match(gallery, /const fetchLimit = limit \+ 1;/);
assert.doesNotMatch(gallery, /1000|1001/);

console.log(`Pagination verification passed for ${routeFiles.length} routes.`);
