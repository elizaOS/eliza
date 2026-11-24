import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeWhole } from "../run.ts"
import { check, syncDoc, themeCss, tokensCss } from "./generate.ts"
import { parseTokens } from "./tokens.ts"

const read = (file: string) => readFileSync(file, "utf8")

export function writeTextIfChanged(file: string, text: string): void {
  if (!existsSync(file) || read(file) !== text) writeWhole(file, text)
}

export function loadTokens(directory: string) {
  return parseTokens(JSON.parse(read(join(directory, "tokens.json"))))
}

export function buildTokenProject(directory: string, tokens = loadTokens(directory)): void {
  const generated = join(directory, "generated")
  mkdirSync(generated, { recursive: true })
  writeTextIfChanged(join(generated, "tokens.css"), tokensCss(tokens))
  writeTextIfChanged(join(generated, "theme.css"), themeCss(tokens))
  const design = join(directory, "design.md")
  writeTextIfChanged(design, syncDoc(read(design), tokens))
}

export function checkTokenProject(directory: string): string[] {
  return check(loadTokens(directory), read(join(directory, "design.md")))
}
