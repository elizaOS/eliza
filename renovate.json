{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:base"],
  "baseBranches": ["develop", "main"],
  "packageRules": [
    {
      "groupName": "Discord.js ecosystem",
      "matchPackagePatterns": ["^@discordjs/", "^discord.js"]
    },
    {
      "groupName": "TypeScript and related",
      "matchPackagePatterns": ["^@typescript-eslint/", "^typescript$", "^ts-", "^tslib$"]
    },
    {
      "groupName": "Rollup and plugins",
      "matchPackagePatterns": ["^@rollup/", "^rollup"]
    },
    {
      "groupName": "ESLint and formatting",
      "matchPackagePatterns": ["^eslint", "^prettier"]
    }
  ],
  "timezone": "UTC",
  "schedule": ["every weekend"],
  "prHourlyLimit": 2,
  "prConcurrentLimit": 10,
  "rangeStrategy": "pin",
  "separateMajorMinor": true,
  "dependencyDashboard": true
}
