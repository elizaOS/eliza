#!/usr/bin/env node
/** Fail-closed verifier for Gradle connected-Android-test JUnit XML. */
import fs from "node:fs";
import path from "node:path";
import { isMainModule } from "../distro-android/is-main.mjs";

function usage(message) {
  if (message) console.error(`[android-instrumentation-results] ${message}`);
  console.error(
    "Usage: verify-android-instrumentation-results.mjs --results <DIR> --required-class <FQCN> --min-tests <N>",
  );
  process.exit(2);
}

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function verifyInstrumentationXml(xmlDocuments, options) {
  const requiredClass = options.requiredClass;
  const minTests = options.minTests;
  let requiredTests = 0;
  let requiredSkipped = 0;
  let failures = 0;
  let errors = 0;

  for (const xml of xmlDocuments) {
    for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
      const attributes = match[1];
      failures += Number(attributes.match(/\bfailures="(\d+)"/)?.[1] ?? 0);
      errors += Number(attributes.match(/\berrors="(\d+)"/)?.[1] ?? 0);
    }
    const testcase = /<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    for (const match of xml.matchAll(testcase)) {
      const attributes = match[1];
      const className = attributes.match(/\bclassname="([^"]+)"/)?.[1];
      if (className !== requiredClass) continue;
      requiredTests += 1;
      if (/<skipped\b/.test(match[2] ?? "")) requiredSkipped += 1;
    }
  }

  const problems = [];
  if (failures > 0 || errors > 0) {
    problems.push(`JUnit reported failures=${failures}, errors=${errors}`);
  }
  if (requiredTests < minTests) {
    problems.push(
      `${requiredClass} executed ${requiredTests} tests; expected at least ${minTests}`,
    );
  }
  if (requiredSkipped > 0) {
    problems.push(`${requiredClass} skipped ${requiredSkipped} tests`);
  }
  return {
    pass: problems.length === 0,
    requiredClass,
    requiredTests,
    requiredSkipped,
    failures,
    errors,
    problems,
  };
}

function collectXml(directory) {
  const documents = [];
  const visit = (entry) => {
    for (const name of fs.readdirSync(entry)) {
      const target = path.join(entry, name);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) visit(target);
      else if (name.endsWith(".xml"))
        documents.push(fs.readFileSync(target, "utf8"));
    }
  };
  visit(directory);
  return documents;
}

if (isMainModule(import.meta)) {
  const results = value("--results");
  const requiredClass = value("--required-class");
  const minTests = Number(value("--min-tests"));
  if (
    !results ||
    !requiredClass ||
    !Number.isInteger(minTests) ||
    minTests < 1
  ) {
    usage(
      "all arguments are required and --min-tests must be a positive integer",
    );
  }
  if (!fs.existsSync(results) || !fs.statSync(results).isDirectory()) {
    usage(`results directory does not exist: ${results}`);
  }
  const documents = collectXml(results);
  if (documents.length === 0) usage(`no JUnit XML found under ${results}`);
  const verdict = verifyInstrumentationXml(documents, {
    requiredClass,
    minTests,
  });
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.pass) process.exit(1);
}
