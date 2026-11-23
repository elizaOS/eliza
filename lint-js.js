import { spawnSync } from "node:child_process"
import { constants } from "node:os"
import process from "node:process"

const vibeFiles = "**/*.{vibe,vibex}"
const packageGroups = [
  [
    "packages/agent",
    "packages/plugin-assistant",
    "packages/plugin-browser",
    "packages/cloud",
    "packages/core",
    "packages/plugin-localinference",
    "packages/os",
  ],
  [
    "packages/plugin-calendar",
    "packages/plugin-files",
    "packages/plugin-inbox",
    "packages/plugin-maps",
    "packages/plugin-notes",
    "packages/ui",
    "packages/plugin-workflows",
    "vibestack/studio",
  ],
]
const ignoreVibe = ["--ignore-pattern", vibeFiles]
const ignorePackages = packageGroups.flat().flatMap((directory) => ["--ignore-pattern", `${directory}/`])
const extra = process.argv.slice(2)
const passes = extra.length
  ? [[".", "--max-warnings", "0", ...extra]]
  : [
    [vibeFiles, "--no-error-on-unmatched-pattern", "--max-warnings", "0"],
    ...packageGroups.map((group) => [...group, ...ignoreVibe, "--no-error-on-unmatched-pattern", "--max-warnings", "0"]),
    [".", ...ignoreVibe, ...ignorePackages, "--max-warnings", "0"],
  ]

let exitCode = 0
for (const args of passes) {
  const { error, signal, status } = spawnSync("eslint", args, { stdio: "inherit" })
  if (error) throw error
  if (signal) {
    exitCode = 128 + constants.signals[signal]
    break
  }
  exitCode = Math.max(exitCode, status ?? 2)
}
process.exitCode = exitCode
