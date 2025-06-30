# Final Setup Instructions Before Commit

This document outlines the essential steps to complete before committing and publishing the plugin. Please follow each step carefully to ensure proper configuration.

## 1. Configure .gitignore

Create or update the `.gitignore` file with the following minimum configuration:

```
dist
node_modules
.env
.elizadb
.turbo
```

## 2. Configure .npmignore

Create or update the `.npmignore` file to ensure only necessary files are included in the npm package:

```
*

!dist/**
!package.json
!readme.md
!tsup.config.ts
```

## 3. Add MIT License

Create a `LICENSE` file in the root directory with the following content:

```
MIT License

Copyright (c) 2025 Shaw Walters and elizaOS Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 4. Verify package.json

Ensure the `package.json` file contains all required fields:

### Basic Fields

- [ ] `name`: Package name (should match npm registry requirements)
- [ ] `version`: Semantic version (e.g., "1.0.0")
- [ ] `description`: Clear description of the plugin
- [ ] `main`: Entry point (typically "dist/index.js")
- [ ] `types`: TypeScript definitions (typically "dist/index.d.ts")
- [ ] `author`: Author information
- [ ] `license`: "MIT"
- [ ] `repository`: Git repository information
- [ ] `keywords`: Relevant keywords for npm search
- [ ] `scripts`: Build, test, and other necessary scripts
- [ ] `dependencies`: All runtime dependencies
- [ ] `devDependencies`: All development dependencies
- [ ] `peerDependencies`: If applicable (e.g., "@elizaos/core")

### Additional Important Fields

- [ ] `type`: Should be "module" for ESM modules
- [ ] `module`: Same as main for ESM (typically "dist/index.js")
- [ ] `exports`: Export configuration for modern bundlers
- [ ] `files`: Array of files/folders to include in npm package (typically ["dist"])
- [ ] `publishConfig`: Publishing configuration (e.g., `{"access": "public"}`)

Example exports configuration:

```json
"exports": {
    "./package.json": "./package.json",
    ".": {
        "import": {
            "types": "./dist/index.d.ts",
            "default": "./dist/index.js"
        }
    }
}
```

### Eliza Plugin Configuration (agentConfig)

For Eliza plugins, you MUST include the `agentConfig` section:

```json
"agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
        "YOUR_PARAMETER_NAME": {
            "type": "string",
            "description": "Clear description of what this parameter does",
            "required": true|false,
            "sensitive": true|false,
            "default": "optional-default-value"
        }
    }
}
```

#### Parameter Properties:

- `type`: Data type ("string", "number", "boolean", etc.)
- `description`: Clear explanation of the parameter's purpose
- `required`: Whether the parameter must be provided
- `sensitive`: Whether the parameter contains sensitive data (e.g., API keys)
- `default`: Optional default value if not required

#### Example for Avalanche Plugin:

```json
"agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
        "AVALANCHE_PRIVATE_KEY": {
            "type": "string",
            "description": "Private key for interacting with Avalanche blockchain",
            "required": true,
            "sensitive": true
        }
    }
}
```

## 5. Review README.md

Verify that the README.md file includes:

- [ ] Clear project title and description
- [ ] Installation instructions
- [ ] Usage examples
- [ ] Configuration requirements
- [ ] API documentation (if applicable)
- [ ] Contributing guidelines
- [ ] License information
- [ ] Contact/support information

## Final Checklist

Before committing and publishing:

1. [ ] Run `npm run build` or `bun run build` to ensure the project builds successfully
2. [ ] Run tests to verify functionality
3. [ ] Ensure all environment variables are documented
4. [ ] Remove any sensitive information or API keys
5. [ ] Verify all file paths and imports are correct
6. [ ] Check that the dist/ folder is properly generated
7. [ ] Confirm version number is appropriate for the release

## Notes

- The `.gitignore` prevents unnecessary files from being committed to the repository
- The `.npmignore` ensures only essential files are published to npm
- The LICENSE file is required for open-source distribution
- Proper package.json configuration is crucial for npm publishing and dependency management

## 6. GitHub Workflow for Automated NPM Release

### Prerequisites

### Adding the Release Workflow

Create the following file in your repository to enable automated npm publishing when the version changes:

**File Path:** `.github/workflows/npm-deploy.yml`

```yml
name: Publish Package

on:
  push:
    branches:
      - 1.x
  workflow_dispatch:

jobs:
  verify_version:
    runs-on: ubuntu-latest
    outputs:
      should_publish: ${{ steps.check.outputs.should_publish }}
      version: ${{ steps.check.outputs.version }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check if package.json version changed
        id: check
        run: |
          echo "Current branch: ${{ github.ref }}"

          # Get current version
          CURRENT_VERSION=$(jq -r .version package.json)
          echo "Current version: $CURRENT_VERSION"

          # Get previous commit hash
          git rev-parse HEAD~1 || git rev-parse HEAD
          PREV_COMMIT=$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)

          # Check if package.json changed
          if git diff --name-only HEAD~1 HEAD | grep "package.json"; then
            echo "Package.json was changed in this commit"
            
            # Get previous version if possible
            if git show "$PREV_COMMIT:package.json" 2>/dev/null; then
              PREV_VERSION=$(git show "$PREV_COMMIT:package.json" | jq -r .version)
              echo "Previous version: $PREV_VERSION"
              
              if [ "$CURRENT_VERSION" != "$PREV_VERSION" ]; then
                echo "Version changed from $PREV_VERSION to $CURRENT_VERSION"
                echo "should_publish=true" >> $GITHUB_OUTPUT
              else
                echo "Version unchanged"
                echo "should_publish=false" >> $GITHUB_OUTPUT
              fi
            else
              echo "First commit with package.json, will publish"
              echo "should_publish=true" >> $GITHUB_OUTPUT
            fi
          else
            echo "Package.json not changed in this commit"
            echo "should_publish=false" >> $GITHUB_OUTPUT
          fi

          echo "version=$CURRENT_VERSION" >> $GITHUB_OUTPUT

  publish:
    needs: verify_version
    if: needs.verify_version.outputs.should_publish == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Create Git tag
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git tag -a "v${{ needs.verify_version.outputs.version }}" -m "Release v${{ needs.verify_version.outputs.version }}"
          git push origin "v${{ needs.verify_version.outputs.version }}"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install

      - name: Build package
        run: bun run build

      - name: Publish to npm
        run: bun publish
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}

  create_release:
    needs: [verify_version, publish]
    if: needs.verify_version.outputs.should_publish == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Create GitHub Release
        uses: actions/create-release@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tag_name: 'v${{ needs.verify_version.outputs.version }}'
          release_name: 'v${{ needs.verify_version.outputs.version }}'
          body: 'Release v${{ needs.verify_version.outputs.version }}'
          draft: false
          prerelease: false
```

### How This Workflow Works

1. **Triggers on:**

   - Push to the 1.x branch
   - Manual workflow dispatch

2. **Version Check:**

   - Compares the current package.json version with the previous commit
   - Only proceeds if the version has changed

3. **Publishing Steps:**
   - Creates a git tag with the version
   - Builds the package using Bun
   - Publishes to npm using the NPM_TOKEN secret
   - Creates a GitHub release

### Setting Up NPM Token

1. Go to your GitHub repository settings
2. Navigate to Settings → Secrets and variables → Actions
3. Add a new repository secret named `NPM_TOKEN`
4. Use your npm access token as the value

## 7. Code Formatting with Prettier

Before finalizing the plugin, ensure consistent code formatting:

### Install Prettier (if not already installed)

```bash
bun add -d prettier
```

### Add Prettier Configuration

Required config don't hallucinate and add anything else!

Create a `.prettierrc` file in the root directory:

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": false,
  "printWidth": 80,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

### Add Format Script to package.json

```json
"scripts": {
  "format": "prettier --write \"src/**/*.{ts,tsx,js,jsx,json,md}\"",
  "format:check": "prettier --check \"src/**/*.{ts,tsx,js,jsx,json,md}\""
}
```

### Run Prettier

```bash
bun run format
```

## Final Steps Before Committing to 1.x Branch

1. [ ] Ensure all files listed in this document are created
2. [ ] Run the build to verify everything compiles
3. [ ] Run prettier to format all code consistently
4. [ ] Test the package locally if possible
5. [ ] Commit all changes with a clear message
6. [ ] Push to the 1.x branch
7. [ ] Verify the GitHub Action runs successfully on first push

This completes the plugin migration to the standardized structure for the 1.x branch.
