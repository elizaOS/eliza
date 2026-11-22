#!/usr/bin/env node
// Works on the current directory: ./tokens.json and ./design.md in, ./generated/{tokens,theme}.css out.
import { readFileSync, writeFileSync } from "node:fs"
import { buildTokenProject, checkTokenProject, loadTokens } from "./project.ts"
import { applyChanges } from "./tokens.ts"

const read = (file: string) => readFileSync(file, "utf8")
const directory = process.cwd()
const [command, ...rest] = process.argv.slice(2)
const file = rest.find((word) => !word.startsWith("--"))
try {
  if (command === "build") buildTokenProject(directory)
  else if (command === "check") {
    const issues = checkTokenProject(directory)
    if (issues.length) throw new Error(issues.join("\n"))
  } else if (command === "apply" && file) {
    const { tokens, diff } = applyChanges(loadTokens(directory), JSON.parse(read(file)))
    console.log(diff)
    if (rest.includes("--write")) {
      writeFileSync("tokens.json", `${JSON.stringify(tokens, null, 2)}\n`)
      buildTokenProject(directory, tokens)
    } else console.log("Not written. Pass --write to apply.")
  } else throw new Error("usage: cli.ts build | check | apply <changes.json> [--write]")
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
