import { readFileSync } from "fs";
import { characterSchema } from "../lib/core/character";

// Read and validate the Sam Altman character
const samAltmanJson = readFileSync("./characters/sam-altman.json", "utf-8");
const samAltmanData = JSON.parse(samAltmanJson);

const result = characterSchema.safeParse(samAltmanData);

if (result.success) {
  console.log("✅ Sam Altman character is valid!");
  console.log(`Character: ${result.data.name} (${result.data.username})`);
} else {
  console.error("❌ Validation failed:");
  result.error.issues.forEach((issue, index) => {
    console.error(`${index + 1}. ${issue.path.join(".")}: ${issue.message}`);
  });
}
