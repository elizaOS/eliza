#!/usr/bin/env bun

import path from "node:path";
import { config } from "dotenv";
import {
  buildLocalCharacterRoster,
  writeLocalCharacterSheets,
} from "../packages/agents/src/character-roster/local-roster";

config({ path: path.resolve(process.cwd(), ".env") });
config({ path: path.resolve(process.cwd(), ".env.local") });

async function main(): Promise<void> {
  const filePaths = await writeLocalCharacterSheets();
  const roster = buildLocalCharacterRoster();

  console.log(`Generated ${filePaths.length} local character sheets.`);
  console.log(`Output directory: ${path.dirname(filePaths[0] ?? "")}`);
  console.log("");

  for (const sheet of roster) {
    console.log(`${sheet.name} (@${sheet.username})`);
    console.log(`  ${sheet.bio[0] ?? ""}`);
    console.log(
      `  ${sheet.feed.alignment}/${sheet.feed.team} | ${sheet.feed.scamProfile.replaceAll("_", " ")} | ${sheet.settings.groq.primary}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
