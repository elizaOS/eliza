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
commit_data=$(git log --reverse --pretty=format:"%H %an %ad %P" --date=short)

# Process the commit data to identify which commits to keep
<<<<<<< Updated upstream
declare -A keep_commits
declare -A author_commits
=======
# Use files to track commits instead of associative arrays (for macOS compatibility)
temp_dir=$(mktemp -d)
keep_commits_dir="$temp_dir/keep_commits"
author_commits_dir="$temp_dir/author_commits"
merge_commits_dir="$temp_dir/merge_commits"

mkdir -p "$keep_commits_dir"
mkdir -p "$author_commits_dir"
mkdir -p "$merge_commits_dir"

>>>>>>> Stashed changes
previous_commit=""
previous_author=""
previous_date=""

<<<<<<< Updated upstream
while IFS=" " read -r hash author date rest; do
  key="${author}:${date}"
  
  # If this is the first commit by this author on this date, mark it to keep
  if [[ -z "${author_commits[$key]}" ]]; then
    keep_commits[$hash]=1
    author_commits[$key]=$hash
    echo "Keeping commit $hash by $author on $date"
=======
while IFS=" " read -r hash author date parents rest; do
  # Check if this is a merge commit (has multiple parents)
  parent_count=$(echo "$parents" | wc -w)
  if [ "$parent_count" -gt 1 ]; then
    # This is a merge commit, always keep these
    touch "$keep_commits_dir/$hash"
    touch "$merge_commits_dir/$hash"
    echo "Keeping merge commit $hash by $author on $date"
>>>>>>> Stashed changes
  else
    key="${author}:${date}"
    key_safe=$(echo "$key" | tr ':' '_')
    
    # If this is the first commit by this author on this date, mark it to keep
    if [ ! -f "$author_commits_dir/$key_safe" ]; then
      touch "$keep_commits_dir/$hash"
      echo "$hash" > "$author_commits_dir/$key_safe"
      echo "Keeping commit $hash by $author on $date"
    else
      echo "Will squash commit $hash by $author on $date"
    fi
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
<<<<<<< Updated upstream
git log --reverse --pretty=format:"%H %an %ad" --date=short | while IFS=" " read -r hash author date rest; do
  if [[ -n "${keep_commits[$hash]}" ]]; then
=======
git log --reverse --pretty=format:"%H %an %ad %P" --date=short | while IFS=" " read -r hash author date parents rest; do
  # Check if this is a merge commit
  parent_count=$(echo "$parents" | wc -w)
  if [ "$parent_count" -gt 1 ]; then
    # For merge commits, we need to use the pick command but with a comment
    echo "pick $hash # merge commit" >> "$git_commands_file"
  elif [ -f "$keep_commits_dir/$hash" ]; then
>>>>>>> Stashed changes
    echo "pick $hash" >> "$git_commands_file"
  else
    echo "fixup $hash" >> "$git_commands_file"
  fi
done

# We'll use a different approach to handle merges - instead of interactive rebase, 
# let's try a different strategy that preserves merges better
echo "Note: Due to merge commits, we'll preserve all merge commits and"
echo "only squash non-merge commits from the same author/day."

# Alternative approach for rebasing with merges
# First, create a mapping file that tells us which commits should be preserved
mapping_file=$(mktemp)
for hash in $(ls "$keep_commits_dir"); do
  echo "$hash" >> "$mapping_file"
done

# Now let's process each commit and create a script to build a new history
build_script=$(mktemp)
echo "#!/bin/bash" > "$build_script"
echo "set -e" >> "$build_script"
echo "git checkout --orphan temp-branch" >> "$build_script"

# Now iterate through commits in chronological order
git log --reverse --pretty=format:"%H %an %ad %P %s" --date=short | while IFS=" " read -r hash author date parents subject; do
  # Get the parent count to detect merge commits
  parent_count=$(echo "$parents" | wc -w)
  
  if [ "$parent_count" -gt 1 ] || [ -f "$keep_commits_dir/$hash" ]; then
    # For merges or commits we want to keep, cherry-pick them
    message="$(git log -1 --pretty=%B "$hash")"
    echo "echo \"Processing $hash ($subject)\"" >> "$build_script"
    echo "git cherry-pick --allow-empty $hash || (echo \"Cherry-pick failed for $hash, continuing...\" && git cherry-pick --abort || true)" >> "$build_script"
  fi
done

echo "git branch -f v2-squashed temp-branch" >> "$build_script"
echo "git checkout v2-squashed" >> "$build_script"
echo "git branch -D temp-branch" >> "$build_script"

# Make the script executable and run it
chmod +x "$build_script"
echo "Running build script to create new history preserving merge commits..."
bash "$build_script"

# Clean up
<<<<<<< Updated upstream
rm "$git_commands_file"
=======
rm "$git_commands_file" "$mapping_file" "$build_script"
rm -rf "$temp_dir"
>>>>>>> Stashed changes

echo "Squashing complete! New branch 'v2-squashed' created."
echo "Number of commits in original branch: $total_commits"
echo "Number of commits in squashed branch: $(git rev-list --count HEAD)"
echo ""
echo "To push the squashed branch to remote:"
echo "  git push -f origin v2-squashed"
echo ""
echo "To switch back to your original branch:"
echo "  git checkout $current_branch" 