#!/usr/bin/env node
// Works on the current directory: ./tokens.json and ./design.md in, ./generated/{tokens,theme}.css out.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { check, syncDoc, themeCss, tokensCss } from "./generate.ts"
import { type Tokens, applyChanges, parseTokens } from "./tokens.ts"

const read = (file: string) => readFileSync(file, "utf8")
const load = () => parseTokens(JSON.parse(read("tokens.json")))
const build = (tokens: Tokens) => {
  mkdirSync("generated", { recursive: true })
  writeFileSync("generated/tokens.css", tokensCss(tokens))
  writeFileSync("generated/theme.css", themeCss(tokens))
  writeFileSync("design.md", syncDoc(read("design.md"), tokens))
}

const [command, ...rest] = process.argv.slice(2)
const file = rest.find((word) => !word.startsWith("--"))
try {
  if (command === "build") build(load())
  else if (command === "check") {
    const issues = check(load(), read("design.md"))
    if (issues.length) throw new Error(issues.join("\n"))
  } else if (command === "apply" && file) {
    const { tokens, diff } = applyChanges(load(), JSON.parse(read(file)))
    console.log(diff)
    if (rest.includes("--write")) {
      writeFileSync("tokens.json", `${JSON.stringify(tokens, null, 2)}\n`)
      build(tokens)
    } else console.log("Not written. Pass --write to apply.")
  } else throw new Error("usage: cli.ts build | check | apply <changes.json> [--write]")
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
