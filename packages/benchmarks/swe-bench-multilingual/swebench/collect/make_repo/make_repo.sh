#!/usr/bin/env bash

# Mirror repository to https://github.com/swe-bench
# Usage make_repo.sh {gh organization}/{gh repository}

# Abort on error
set -euo pipefail

REPO_TARGET=$1

echo "** Checking if target repository '$REPO_TARGET' exists..."
# Check if the target repository exists
if ! gh repo view "$REPO_TARGET" > /dev/null 2>&1; then
    echo "ERROR: Cannot access repository '$REPO_TARGET'. Please check:"
    echo "1. The repository exists and is accessible"
    echo "2. You are authenticated with GitHub CLI (run 'gh auth status')"
    echo "3. The repository name is correct"
    exit 1
fi
echo "** Target repository '$REPO_TARGET' exists and is accessible."

# Set the organization and repository names
ORG_NAME="swe-bench-repos"
NEW_REPO_NAME="${REPO_TARGET//\//__}"

echo "** Checking if mirror repository '$ORG_NAME/$NEW_REPO_NAME' already exists..."
# Check if the new repository already exists
if gh repo view "$ORG_NAME/$NEW_REPO_NAME" > /dev/null 2>&1; then
    echo "The repository $ORG_NAME/$NEW_REPO_NAME already exists."
    exit 1
else
    echo "** Mirror repository doesn't exist, creating it..."
    # Create mirror repository
    gh repo create "$ORG_NAME/$NEW_REPO_NAME" --private
fi

# Check if the repository creation was successful
if [ $? -eq 0 ]; then
    echo "** Repository created successfully at $ORG_NAME/$NEW_REPO_NAME."
else
    echo "Failed to create the repository."
    exit 1
fi

# Clone the target repository
echo "** Cloning $REPO_TARGET..."
TARGET_REPO_DIR="${REPO_TARGET##*/}.git"

# Check if the local repository directory already exists
if [ -d "$TARGET_REPO_DIR" ]; then
    echo "The local repository directory $TARGET_REPO_DIR already exists."
    exit 1
fi

git clone --bare git@github.com:$REPO_TARGET.git

# Push files to the mirror repository
echo "** Performing mirror push of files to $ORG_NAME/$NEW_REPO_NAME..."
cd "$TARGET_REPO_DIR"; git push --mirror git@github.com:$ORG_NAME/$NEW_REPO_NAME

# Remove the target repository
cd ..; rm -rf "$TARGET_REPO_DIR"

# Clone the mirror repository
git clone git@github.com:$ORG_NAME/$NEW_REPO_NAME.git

# Clean up GitHub automation files and directories
echo "** Cleaning up GitHub automation files..."
cd "$NEW_REPO_NAME"

# Track if any changes were made
CHANGES_MADE=false

# Remove GitHub Actions workflows
if [ -d ".github/workflows" ]; then
    echo "Removing .github/workflows"
    rm -rf ".github/workflows"
    CHANGES_MADE=true
fi

# Remove Dependabot configuration
if [ -f ".github/dependabot.yml" ] || [ -f ".github/dependabot.yaml" ]; then
    echo "Removing Dependabot configuration"
    rm -f ".github/dependabot.yml" ".github/dependabot.yaml"
    CHANGES_MADE=true
fi

# Remove GitHub Codespaces configuration
if [ -d ".devcontainer" ]; then
    echo "Removing .devcontainer directory"
    rm -rf ".devcontainer"
    CHANGES_MADE=true
fi

# Remove other GitHub automation files
GITHUB_FILES=(
    ".github/CODEOWNERS"
    ".github/FUNDING.yml"
    ".github/FUNDING.yaml"
    ".github/ISSUE_TEMPLATE"
    ".github/PULL_REQUEST_TEMPLATE"
    ".github/pull_request_template.md"
    ".github/issue_template.md"
    ".github/SECURITY.md"
    ".github/CODE_OF_CONDUCT.md"
    ".github/CONTRIBUTING.md"
)

for file in "${GITHUB_FILES[@]}"; do
    if [ -e "$file" ]; then
        echo "Removing $file"
        rm -rf "$file"
        CHANGES_MADE=true
    fi
done

# Commit and push changes if any were made
if [ "$CHANGES_MADE" = true ]; then
    echo "** Committing and pushing cleanup changes..."
    # Get the current default branch name
    DEFAULT_BRANCH=$(git branch --show-current)
    git add -A
    git commit -m "Removed GitHub automation files and configurations"
    git push origin "$DEFAULT_BRANCH"
    echo "** GitHub automation cleanup completed."
else
    echo "** No GitHub automation files found to clean up."
fi

cd ..

rm -rf "$NEW_REPO_NAME"

