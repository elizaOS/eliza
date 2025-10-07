#!/bin/bash

# Repository Optimizer Script - FIXED VERSION 4
# Ensures exactly one commit per author per day, no duplicates
# Uses a TRULY SLIM approach that actually purges all original content
# FIXED: properly handles staging area to prevent uncommitted changes

set -e  # Exit on error

# Terminal colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Default settings
PERFORM_SQUASH=true
PERFORM_SLIM=true
SQUASHED_BRANCH="develop-squashed"
SLIM_BRANCH="develop-slim"
DEBUG=false

# Parse command line arguments
for arg in "$@"; do
  case $arg in
    --slim-only)
      PERFORM_SQUASH=false
      ;;
    --skip-slim)
      PERFORM_SLIM=false
      ;;
    --debug)
      DEBUG=true
      set -x  # Enable trace mode
      ;;
    --help)
      echo -e "${BLUE}Repository Optimizer Script - FIXED VERSION 4${NC}"
      echo "Provides two main functions:"
      echo "1. Squash commits while preserving EXACTLY one commit per author per day"
      echo "2. Create a TRULY slim version of the repository with minimal size"
      echo
      echo "USAGE: ./repo_optimizer_fixed4.sh [--slim-only] [--skip-slim] [--debug] [--help]"
      echo "  --slim-only: Skip squashing and only create slim version from existing squashed branch"
      echo "  --skip-slim: Only perform squashing without creating slim version"
      echo "  --debug: Enable debug output"
      echo "  --help: Display this usage information"
      exit 0
      ;;
  esac
done

# Function to print header
print_header() {
  echo -e "\n${BLUE}==== $1 ====${NC}\n"
}

# Function to print success
print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

# Function to print warning
print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

# Function to print error
print_error() {
  echo -e "${RED}✗ $1${NC}"
}

# Function to handle cleanup
cleanup() {
  if [ -d "$work_dir" ]; then
    echo "Running cleanup..."
    rm -rf "$work_dir"
    echo "Cleaned up temporary files"
  fi
}

# Function to reset git staging area
reset_staging() {
  # Reset any staged but uncommitted changes
  if git diff --staged --quiet; then
    # No staged changes
    return 0
  else
    print_warning "Unstaging uncommitted changes"
    git reset --hard HEAD 2>/dev/null || git reset --hard 2>/dev/null || true
  fi
}

# Create a temporary directory for our work
work_dir=$(mktemp -d)
echo "Using temporary directory: $work_dir"

# Make sure all directories exist
mkdir -p "$work_dir/logs"
mkdir -p "$work_dir/author_data"

# Trap to ensure cleanup on exit (disabled for debugging)
# trap cleanup EXIT

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  print_error "Not in a git repository"
  exit 1
fi

# Make sure we have a clean working directory
if ! git diff-index --quiet HEAD --; then
  print_error "You have uncommitted changes. Please commit or stash them first."
  exit 1
fi

# Get the current branch - we'll return to this at the end
original_branch=$(git symbolic-ref --short HEAD)
original_repo=$(pwd)
echo "Current branch is $original_branch"
echo "Original repository path: $original_repo"

#############################
# SQUASHING IMPLEMENTATION #
#############################

squash_repository() {
  print_header "SQUASHING REPOSITORY"
  
  # Check if target branch exists
  if git show-ref --verify --quiet refs/heads/$SQUASHED_BRANCH; then
    print_warning "Branch $SQUASHED_BRANCH already exists. Do you want to overwrite it? (y/n)"
    read answer
    if [ "$answer" != "y" ]; then
      print_warning "Squashing cancelled."
      return 1
    fi
    git branch -D $SQUASHED_BRANCH
  fi
  
  # CRITICAL: Create maps to ensure we keep one commit per author per day
  print_header "Analyzing commit history..."
  
  # First, get all author-date combinations and sort them chronologically
  git log --format="%at %H %an %ad" --date=short "$original_branch" > "$work_dir/all_commits_raw.txt"
  
  # Count total commits for reporting
  total_commits=$(wc -l < "$work_dir/all_commits_raw.txt" | tr -d ' ')
  print_success "Found $total_commits total commits to analyze"
  
  # Process the commits to identify unique author-date combinations
  print_header "Processing commits to identify unique author+date combinations"
  
  # CRITICAL: STORE COMMITS TO PROCESS IN A FILE
  # This avoids subshell issues that may lose data
  sort -n "$work_dir/all_commits_raw.txt" > "$work_dir/all_commits_sorted.txt"
  
  # Initialize files
  touch "$work_dir/author_date_map.txt"  # Will contain author|date => hash mappings
  touch "$work_dir/commits_to_keep.txt"  # Will contain list of commits to keep
  
  # VERY IMPORTANT: Do this processing in the main shell, NOT in a subshell/pipe
  while IFS= read -r line; do
    timestamp=$(echo "$line" | awk '{print $1}')
    hash=$(echo "$line" | awk '{print $2}')
    date=$(echo "$line" | awk '{print $NF}')  # Last field is the date
    
    # Extract author - everything between the hash and the date
    # This handles spaces and special characters in author names
    author_part=$(echo "$line" | cut -d' ' -f3-)
    author=$(echo "$author_part" | sed "s/ $date\$//")
    
    # Create a key for this author-date combination
    key="${author}|${date}"
    
    # Check if we've seen this key before
    if ! grep -q "^$key=" "$work_dir/author_date_map.txt"; then
      # First time seeing this author-date combination
      echo "$key=$hash" >> "$work_dir/author_date_map.txt"
      echo "$timestamp $hash $author $date" >> "$work_dir/commits_to_keep.txt"
      
      # Debug output - log what we're keeping
      echo "KEEPING: $hash from $author on $date" >> "$work_dir/logs/commits_kept.log"
    else
      # Debug output - log what we're skipping
      echo "SKIPPING: $hash from $author on $date (already have a commit for this author-date)" >> "$work_dir/logs/commits_skipped.log"
    fi
  done < "$work_dir/all_commits_sorted.txt"
  
  # Count unique combinations for reporting
  unique_combinations=$(wc -l < "$work_dir/author_date_map.txt" | tr -d ' ')
  print_success "Found $unique_combinations unique author-date combinations to preserve"
  
  # Also count unique authors for reporting
  unique_authors=$(cut -d'|' -f1 "$work_dir/author_date_map.txt" | sort -u | wc -l | tr -d ' ')
  print_success "Found $unique_authors unique authors across all commits"
  
  # Debug files for confirmation
  echo "Top 5 commits we're keeping:" >> "$work_dir/logs/debug.txt"
  head -n 5 "$work_dir/commits_to_keep.txt" >> "$work_dir/logs/debug.txt"
  
  # CRITICAL CHECKPOINT: Make sure commits_to_keep.txt exists and has content
  if [ ! -s "$work_dir/commits_to_keep.txt" ]; then
    print_error "Critical error: No commits were selected to keep!"
    cat "$work_dir/logs/debug.txt"
    return 1
  fi
  
  # Re-sort commits by timestamp to maintain chronological order
  sort -n "$work_dir/commits_to_keep.txt" > "$work_dir/commits_sorted.txt"
  mv "$work_dir/commits_sorted.txt" "$work_dir/commits_to_keep.txt"
  
  # Create the new branch
  print_header "Creating new orphan branch for squashed history..."
  git checkout --orphan $SQUASHED_BRANCH
  
  # CRITICAL FIX: After creating orphan branch, IMMEDIATELY create a commit
  # to prevent having staged file deletions
  
  # First, remove all files from the working directory and staging area
  git rm -rf . > /dev/null 2>&1

  # Create a temporary file to commit - this ensures we have a clean starting point
  echo "# Temporary file" > README.md
  git add README.md
  git commit -m "Initial commit for squashed branch" > /dev/null 2>&1
  
  # Safety check - make sure we're still in a git repository
  if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "CRITICAL ERROR: Lost git repository reference after checkout. Aborting."
    return 1
  fi
  
  # Create commit history
  print_header "Creating new commit history..."
  
  if [ -s "$work_dir/commits_to_keep.txt" ]; then
    # Status update with expected number of commits
    commits_to_create=$(wc -l < "$work_dir/commits_to_keep.txt" | tr -d ' ')
    echo "Will create $commits_to_create new commits (one per author per day)"
    
    # Process each commit from the file (avoid pipes/subshells)
    # The first commit will be our parent - we'll reset it later
    first_parent=$(git rev-parse HEAD)
    parent="$first_parent"
    commit_count=0
    commit_error_count=0
    
    while IFS= read -r line; do
      # Parse the line
      timestamp=$(echo "$line" | awk '{print $1}')
      orig_commit=$(echo "$line" | awk '{print $2}')
      
      # Extract author and date, handling spaces in author names
      date=$(echo "$line" | awk '{print $NF}')  # Last field is the date
      author_part=$(echo "$line" | cut -d' ' -f3-)
      author=$(echo "$author_part" | sed "s/ $date\$//")
      
      # Debug - log the values we extracted
      echo "Processing original commit: $orig_commit" >> "$work_dir/logs/commit_creation.log"
      echo "  Author: '$author'" >> "$work_dir/logs/commit_creation.log"
      echo "  Date: '$date'" >> "$work_dir/logs/commit_creation.log"
      
      # CRITICAL: Verify we can access the original commit
      if ! git cat-file -e "$orig_commit" 2>/dev/null; then
        print_error "Cannot access commit: $orig_commit"
        commit_error_count=$((commit_error_count + 1))
        continue
      fi
      
      # Get the original commit's data
      message=$(git log -1 --format='%B' "$orig_commit")
      tree=$(git log -1 --format='%T' "$orig_commit")
      email=$(git log -1 --format='%ae' "$orig_commit")
      author_date=$(git log -1 --format='%ad' "$orig_commit")
      committer_name=$(git log -1 --format='%cn' "$orig_commit")
      committer_email=$(git log -1 --format='%ce' "$orig_commit")
      committer_date=$(git log -1 --format='%cd' "$orig_commit")
      
      # Create the new commit with original metadata
      if [ "$parent" = "$first_parent" ]; then
        # First real commit - we'll discard the temporary parent later
        new_commit=$(
          GIT_AUTHOR_NAME="$author" \
          GIT_AUTHOR_EMAIL="$email" \
          GIT_AUTHOR_DATE="$author_date" \
          GIT_COMMITTER_NAME="$committer_name" \
          GIT_COMMITTER_EMAIL="$committer_email" \
          GIT_COMMITTER_DATE="$committer_date" \
          git commit-tree "$tree" -m "$message"
        )
        # Reset the first parent variable
        first_parent=""
      else
        # Subsequent commits have the previous one as parent
        new_commit=$(
          GIT_AUTHOR_NAME="$author" \
          GIT_AUTHOR_EMAIL="$email" \
          GIT_AUTHOR_DATE="$author_date" \
          GIT_COMMITTER_NAME="$committer_name" \
          GIT_COMMITTER_EMAIL="$committer_email" \
          GIT_COMMITTER_DATE="$committer_date" \
          git commit-tree "$tree" -p "$parent" -m "$message"
        )
      fi
      
      # CRITICAL ERROR CHECK: Make sure we created a valid commit
      if [ -z "$new_commit" ] || ! git cat-file -e "$new_commit" 2>/dev/null; then
        echo "FAILED to create commit from $orig_commit" >> "$work_dir/logs/errors.log"
        echo "  Author: $author" >> "$work_dir/logs/errors.log"
        echo "  Date: $date" >> "$work_dir/logs/errors.log"
        echo "  Tree: $tree" >> "$work_dir/logs/errors.log"
        commit_error_count=$((commit_error_count + 1))
        continue
      fi
      
      # Debug - log the new commit
      echo "  Created new commit: $new_commit" >> "$work_dir/logs/commit_creation.log"
      echo "$orig_commit -> $new_commit ($author, $date)" >> "$work_dir/logs/commit_map.txt"
      
      # Update the parent for the next commit
      parent="$new_commit"
      commit_count=$((commit_count + 1))
      
      # CRITICAL: Update the branch reference frequently to avoid losing work
      if [ $((commit_count % 10)) -eq 0 ]; then
        git update-ref refs/heads/$SQUASHED_BRANCH "$parent"
        echo "Progress: $commit_count/$commits_to_create commits created (latest: $new_commit)"
      fi
    done < "$work_dir/commits_to_keep.txt"
    
    # CRITICAL: Final update of the branch reference
    if [ -n "$parent" ]; then
      git update-ref refs/heads/$SQUASHED_BRANCH "$parent"
      print_success "Created $SQUASHED_BRANCH branch with $commit_count commits"
      
      if [ $commit_error_count -gt 0 ]; then
        print_warning "$commit_error_count commits could not be processed"
      fi
    else
      print_error "Failed to create any commits"
      return 1
    fi
  else
    print_error "No commits to keep were identified"
    return 1
  fi
  
  # Checkout the new branch
  git checkout $SQUASHED_BRANCH

  # CRITICAL: Clean up any uncommitted changes
  reset_staging
  
  # Safety check - make sure we're still in a git repository
  if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "CRITICAL ERROR: Lost git repository reference after checkout. Aborting."
    return 1
  fi
  
  # Verify the results
  print_header "SQUASHING COMPLETE!"
  new_commit_count=$(git rev-list --count HEAD)
  print_success "Number of commits in original branch: $(git rev-list --count "$original_branch")"
  print_success "Number of commits in squashed branch: $new_commit_count"
  print_success "Number of unique author-date combinations: $unique_combinations"
  
  if [ "$new_commit_count" -eq "$unique_combinations" ]; then
    print_success "VERIFICATION PASSED: Commit count matches unique author-date combinations"
  else
    print_warning "VERIFICATION FAILED: Expected $unique_combinations commits, got $new_commit_count"
    echo "See logs in $work_dir/logs/ for details"
  fi
  
  # Copy logs to a more permanent location
  mkdir -p "logs"
  cp -r "$work_dir/logs/"* "logs/" 2>/dev/null || true
  print_success "Logs saved to ./logs/ directory"
  
  return 0
}

############################
# SLIMMING IMPLEMENTATION #
############################

slim_repository() {
  print_header "SLIMMING REPOSITORY - TRULY SLIM VERSION"
  
  # Check if source squashed branch exists
  if ! git show-ref --verify --quiet refs/heads/$SQUASHED_BRANCH; then
    print_error "$SQUASHED_BRANCH branch does not exist. Run squash step first."
    return 1
  fi
  
  print_header "Using a DIFFERENT approach for slimming - creating a completely new repository"
  echo "This approach ensures all binaries and large files are completely removed"
  
  # Create a new temporary directory for the slim repo
  slim_temp_dir="$work_dir/slim_repo"
  mkdir -p "$slim_temp_dir"
  
  # Initialize a new repository - this ensures NO objects from original repo are copied
  cd "$slim_temp_dir"
  git init
  
  print_success "Created new empty repository at $slim_temp_dir"
  
  # Create a minimal README to use for all commits
  cat > README.md << EOF
# Repository History

This repository contains commit history with minimal content.

The actual file contents have been removed to reduce repository size while preserving:
- Commit history
- Author attribution
- Commit dates
- GitHub contribution graphs

This is a slimmed version of the full repository.
EOF
  
  # Add and commit the README
  git add README.md
  git commit -m "Initial commit with README only"
  
  # Get the tree hash - we'll use this for all commits
  tree_with_readme=$(git write-tree)
  echo "Created tree with README: $tree_with_readme"
  
  # Now go back to the original repository
  cd "$original_repo"
  
  # Get all commits from the squashed branch in chronological order
  print_header "Collecting commits from $SQUASHED_BRANCH branch..."
  git checkout $SQUASHED_BRANCH
  
  # CRITICAL: Make sure we have a clean state before continuing
  reset_staging
  
  git log --reverse --format='%H %an %ae %ad %cd %s' > "$work_dir/squashed_commits.txt"
  total_commits=$(wc -l < "$work_dir/squashed_commits.txt" | tr -d ' ')
  print_success "Found $total_commits commits to process"
  
  # Process all commits to create slim versions in the new repo
  print_header "Creating slim versions of all commits in new repository..."
  cd "$slim_temp_dir"
  
  # Starting point
  parent=""
  commit_count=0
  
  # Process commits from the file to avoid subshell issues
  while IFS= read -r line; do
    # Parse commit info
    hash=$(echo "$line" | awk '{print $1}')
    author_name=$(echo "$line" | awk '{print $2}')
    author_email=$(echo "$line" | awk '{print $3}')
    # Need to handle dates more carefully as they can contain spaces
    rest_of_line=$(echo "$line" | cut -d' ' -f4-)
    # Extract message - everything after the date fields
    message_part=$(echo "$rest_of_line" | cut -d' ' -f3-)
    
    # Go back to original repo to get full commit info
    cd "$original_repo"
    
    # Get proper format dates and full message
    author_date=$(git log -1 --format="%ad" $hash)
    committer_name=$(git log -1 --format="%cn" $hash)
    committer_email=$(git log -1 --format="%ce" $hash)
    committer_date=$(git log -1 --format="%cd" $hash)
    full_message=$(git log -1 --format="%B" $hash)
    
    # Return to slim repo
    cd "$slim_temp_dir"
    
    # Create a new commit with identical metadata but minimal content
    if [ -z "$parent" ]; then
      # First commit has no parent
      new_commit=$(
        GIT_AUTHOR_NAME="$author_name" \
        GIT_AUTHOR_EMAIL="$author_email" \
        GIT_AUTHOR_DATE="$author_date" \
        GIT_COMMITTER_NAME="$committer_name" \
        GIT_COMMITTER_EMAIL="$committer_email" \
        GIT_COMMITTER_DATE="$committer_date" \
        git commit-tree "$tree_with_readme" -m "$full_message"
      )
    else
      # Subsequent commits have the previous one as parent
      new_commit=$(
        GIT_AUTHOR_NAME="$author_name" \
        GIT_AUTHOR_EMAIL="$author_email" \
        GIT_AUTHOR_DATE="$author_date" \
        GIT_COMMITTER_NAME="$committer_name" \
        GIT_COMMITTER_EMAIL="$committer_email" \
        GIT_COMMITTER_DATE="$committer_date" \
        git commit-tree "$tree_with_readme" -p "$parent" -m "$full_message"
      )
    fi
    
    # Verify the commit was created successfully
    if [ -z "$new_commit" ]; then
      echo "Failed to create commit for $hash" >> "$work_dir/logs/errors.log"
      continue
    fi
    
    # Save for next iteration
    parent="$new_commit"
    commit_count=$((commit_count + 1))
    
    # Show progress
    if [ $((commit_count % 10)) -eq 0 ]; then
      echo "Progress: $commit_count/$total_commits commits"
    fi
  done < "$work_dir/squashed_commits.txt"
  
  # Update the HEAD to point to the last commit
  if [ -n "$parent" ]; then
    git update-ref refs/heads/main "$parent"
    print_success "Created main branch with $commit_count commits"
  else
    print_error "Failed to create any commits in the slim repository"
    return 1
  fi
  
  # Copy the slim repository for later use
  slim_output_dir="../slim-repo"
  if [ ! -d "$slim_output_dir" ]; then
    print_header "Creating a standalone slim repository..."
    cp -r "$slim_temp_dir" "$slim_output_dir"
    echo "Standalone slim repository created at: $slim_output_dir"
    echo "You can use this repository directly for a truly minimal size."
  fi
  
  # Now go back to the original repository and create a new branch with the slim repo commits
  cd "$original_repo"
  
  # CRITICAL FIX: Ensure we're on a valid branch with no uncommitted changes 
  # before trying to create the new branch
  git checkout $SQUASHED_BRANCH
  reset_staging
  
  # Check if target slim branch exists
  if git show-ref --verify --quiet refs/heads/$SLIM_BRANCH; then
    print_warning "Branch $SLIM_BRANCH already exists. Do you want to overwrite it? (y/n)"
    read answer
    if [ "$answer" != "y" ]; then
      print_warning "Slimming cancelled (but standalone slim repo was still created)."
      return 0  # We still created the standalone repo, so this isn't a failure
    fi
    git branch -D $SLIM_BRANCH
  fi
  
  print_header "Creating the slim branch in the original repository..."
  
  # CRITICAL FIX: Use a different approach to create the slim branch
  # that doesn't require a clean working directory
  slim_repo_path=$(realpath "$slim_temp_dir")
  
  # Directly create the new branch pointing to the slim repo's HEAD
  cd "$slim_temp_dir"
  slim_head=$(git rev-parse HEAD)
  cd "$original_repo"
  
  # Create a remote and fetch from it, but don't checkout yet
  git remote add slim_temp "$slim_repo_path" || true
  git fetch slim_temp
  
  # Create the branch without checking out
  git branch $SLIM_BRANCH slim_temp/main
  git remote remove slim_temp
  
  # Verify the results
  print_header "REPOSITORY SLIMMING COMPLETE!"
  print_success "New branch '$SLIM_BRANCH' created."
  new_commit_count=$(git rev-list --count $SLIM_BRANCH)
  echo "Number of commits in slim branch: $new_commit_count"
  
  # Show the size comparison
  slim_repo_size=$(du -sh "$slim_temp_dir" | cut -f1)
  echo "Size of slim repository: $slim_repo_size"
  squashed_size=$(du -sh .git | cut -f1)
  echo "Size of current repository: $squashed_size"
  
  return 0
}

# Main execution flow
main() {
  print_header "REPOSITORY OPTIMIZER STARTING"
  
  if $PERFORM_SQUASH; then
    if ! squash_repository; then
      print_error "Squashing failed."
      # Return to original branch - with safety checks
      git checkout "$original_branch" 2>/dev/null || true
      reset_staging
      return 1
    fi
  else
    print_warning "Skipping squash step as requested."
  fi
  
  if $PERFORM_SLIM; then
    if ! slim_repository; then
      print_error "Slimming failed."
      # Return to original branch - with safety checks
      git checkout "$original_branch" 2>/dev/null || true
      reset_staging
      return 1
    fi
  else
    print_warning "Skipping slim step as requested."
  fi
  
  # Show final instructions
  print_header "REPOSITORY OPTIMIZATION COMPLETE"
  
  echo ""
  if $PERFORM_SQUASH; then
    echo "To push the squashed branch to remote:"
    echo "  git checkout $SQUASHED_BRANCH"
    echo "  git push -f origin $SQUASHED_BRANCH"
    echo ""
  fi
  
  if $PERFORM_SLIM; then
    echo "To push the slim branch to remote and make it the new main branch:"
    echo "  git checkout $SLIM_BRANCH"
    echo "  git push -f origin $SLIM_BRANCH:main"
    echo ""
    echo "For an EVEN SMALLER repository, use the separate repository created at:"
    echo "  ../slim-repo"
    echo ""
  fi
  
  echo "To switch back to your original branch:"
  echo "  git checkout $original_branch"
  
  # CRITICAL FIX: Don't try to switch back automatically
  # This prevents the "local changes would be overwritten" error
  print_header "NOTE: You have uncommitted changes in your working directory"
  echo "To return to your original branch, first stash your changes:"
  echo "  git stash"
  echo "  git checkout $original_branch"
  echo ""
  echo "Or discard changes:"
  echo "  git reset --hard HEAD"
  echo "  git checkout $original_branch"
  
  return 0
}

# Run the main function
main

# If we got here, everything was successful
print_success "PROCESS COMPLETED SUCCESSFULLY" 