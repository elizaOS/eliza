# Milestone 1: First Steps - Getting Started

This milestone focuses on the initial user experience, from a fresh machine to creating a first project.

## 0. System Setup (Fresh Debian Machine)
- [ ] **Update and Install Base Dependencies**: Run `sudo apt-get update && sudo apt-get install -y curl git`
- [ ] **Install NVM** (Node Version Manager): Run `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash`
- [ ] **Source NVM**: Run `source ~/.nvm/nvm.sh` to use nvm in the current shell session.
- [ ] **Install and Use Correct Node.js Version**: Run `nvm install 23.3.0 && nvm use 23.3.0`
- [ ] **Verify Node.js Version**: Run `node --version` and confirm output is `v23.3.0`.
- [ ] **Install Bun**: Run `curl -fsSL https://bun.sh/install | bash`
- [ ] **Source Bun Profile**: Run `source ~/.bashrc` (or equivalent for your shell) to add Bun to your PATH.
- [ ] **Verify Bun Installation**: Run `bun --version`.
- [ ] **Install ElizaOS CLI**: Run `bun install -g @elizaos/cli`.
- [ ] **Verify CLI Installation**: Run `elizaos --version`.

## 1. Homepage & Introduction (`intro.md`)
- [ ] **Homepage Loads**: Verify the main documentation homepage loads correctly without errors.
- [ ] **Navigation Links**: Click every link in the main navigation and sidebar to ensure they point to valid pages.
- [ ] **Search Functionality**: Test the search bar with a few keywords (e.g., "action", "plugin", "agent") and verify it returns relevant results.
- [ ] **Responsive Design**: Check the homepage and a few key pages on different screen sizes (desktop, tablet, mobile) to ensure the layout is clean and readable.

## 2. Quickstart Guide (`quickstart.md`)
- [ ] **Follow Step-by-Step**: Execute each command in the quickstart guide exactly as written, from `elizaos create` to `elizaos start`.
- [ ] **Verify Final State**: Confirm that a new project is created and that the agent runs successfully at `http://localhost:3000`.
- [ ] **Check "What's Next?" Links**: Verify all links in the "What's Next?" section are correct.

## 3. Installation & Setup
- [ ] **Prerequisites Check**: Verify that the documented prerequisites (Node.js version, Bun, Git) are accurate.
- [ ] **Node.js Version Command**: Run `node --version` and confirm the output matches the documentation's expectation.
- [ ] **Installation Command**: Run `bun install -g @elizaos/cli` and verify it completes without errors.

## 4. First Project Creation (`create` command)
- [ ] **Interactive `create`**: Run `elizaos create` and follow the interactive prompts.
- [ ] **Verify Project Structure**: Compare the generated project's file structure to the one documented in `core/project.md`.
- [ ] **Verify Default `create`**: Run `elizaos create my-first-project -y` and verify it creates a project with the correct name and default settings. 