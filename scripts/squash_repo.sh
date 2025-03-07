#!/bin/bash

# Script to squash commits while preserving one commit per author per day
# This maintains GitHub contribution activity while reducing repository size

set -e  # Exit on error

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "Error: Not in a git repository"
  exit 1
fi

# Make sure we have a clean working directory
if ! git diff-index --quiet HEAD --; then
  echo "Error: You have uncommitted changes. Please commit or stash them first."
  exit 1
fi

# Check if target branch exists
if git show-ref --verify --quiet refs/heads/v2-squashed; then
  echo "Branch v2-squashed already exists. Do you want to overwrite it? (y/n)"
  read answer
  if [ "$answer" != "y" ]; then
    echo "Operation cancelled."
    exit 0
  fi
  git branch -D v2-squashed
fi

# Get the current branch
current_branch=$(git symbolic-ref --short HEAD)
echo "Current branch is $current_branch"

# Create a new branch for the squashed history
git checkout -b v2-squashed

# Get all commits in reverse order (oldest first)
echo "Analyzing commit history..."
commit_data=$(git log --reverse --pretty=format:"%H %an %ad" --date=short)

# Process the commit data to identify which commits to keep
declare -A keep_commits
declare -A author_commits
previous_commit=""
previous_author=""
previous_date=""

while IFS=" " read -r hash author date rest; do
  key="${author}:${date}"
  
  # If this is the first commit by this author on this date, mark it to keep
  if [[ -z "${author_commits[$key]}" ]]; then
    keep_commits[$hash]=1
    author_commits[$key]=$hash
    echo "Keeping commit $hash by $author on $date"
  else
    echo "Will squash commit $hash by $author on $date"
  fi
  
  previous_commit=$hash
  previous_author=$author
  previous_date=$date
done <<< "$commit_data"

# Now create a git filter-branch command to rewrite history
echo "Creating new squashed history..."

# Get the total number of commits
total_commits=$(echo "$commit_data" | wc -l)
echo "Total commits to process: $total_commits"

# Start the interactive rebase
git_commands_file=$(mktemp)

# Get all commits in reverse order again for the rebase script
git log --reverse --pretty=format:"%H %an %ad" --date=short | while IFS=" " read -r hash author date rest; do
  if [[ -n "${keep_commits[$hash]}" ]]; then
    echo "pick $hash" >> "$git_commands_file"
  else
    echo "fixup $hash" >> "$git_commands_file"
  fi
done

# Perform the rebase
GIT_SEQUENCE_EDITOR="cat $git_commands_file >" git rebase -i --root

# Clean up
rm "$git_commands_file"

echo "Squashing complete! New branch 'v2-squashed' created."
echo "Number of commits in original branch: $total_commits"
echo "Number of commits in squashed branch: $(git rev-list --count HEAD)"
echo ""
echo "To push the squashed branch to remote:"
echo "  git push -f origin v2-squashed"
echo ""
echo "To switch back to your original branch:"
echo "  git checkout $current_branch"