#!/bin/bash

# Repository Optimizer Script
# Provides two main functions:
# 1. Squash commits while preserving one commit per author per day
# 2. Create a slim version of the repository that preserves history but minimizes content
#
# USAGE: ./repo_optimizer.sh [--slim-only] [--skip-slim] [--help]
#   --slim-only: Skip squashing and only create slim version from existing squashed branch
#   --skip-slim: Only perform squashing without creating slim version
#   --help: Display usage information

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
SQUASHED_BRANCH="v2-squashed"
SLIM_BRANCH="v2-slim"
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
      echo -e "${BLUE}Repository Optimizer Script${NC}"
      echo "Provides two main functions:"
      echo "1. Squash commits while preserving one commit per author per day"
      echo "2. Create a slim version of the repository that preserves history but minimizes content"
      echo
      echo "USAGE: ./repo_optimizer.sh [--slim-only] [--skip-slim] [--debug] [--help]"
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

# Trap to ensure cleanup on exit
trap cleanup EXIT

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
echo "Current branch is $original_branch"

# Create a temporary directory for our work
work_dir=$(mktemp -d)
echo "Using temporary directory: $work_dir"

# Create empty files to avoid issues with missing files
touch "$work_dir/commits_to_keep.txt"
touch "$work_dir/commits_sorted.txt"

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
  
  # Get all authors - IMPORTANT: specify branch to search
  print_header "Finding all unique authors..."
  authors=$(git log "$original_branch" --format='%an' | sort -u)
  author_count=$(echo "$authors" | wc -l | tr -d ' ')
  print_success "Found $author_count unique authors"
  
  # First collect all commits we want to keep BEFORE creating the new branch
  print_header "Analyzing commits by author and date..."
  total_kept=0
  
  # Process each author directly without using files for author names
  echo "$authors" | while read -r author; do
    if [ -z "$author" ]; then
      echo "Skipping empty author"
      continue
    fi
    
    echo "Processing commits for author: $author"
    
    # Get all commit dates for this author - specify branch
    dates=$(git log "$original_branch" --author="$author" --format='%ad' --date=short | sort -u)
    
    # Process each date directly without writing to files
    echo "$dates" | while read -r date; do
      if [ -z "$date" ]; then
        echo "Skipping empty date for author: $author"
        continue
      fi
      
      echo "Processing date: $date for author: $author"
      
      # Find the oldest commit by this author on this date - specify branch
      commit=$(git log "$original_branch" --author="$author" --format='%H' --date=short --after="$date 00:00:00" --before="$date 23:59:59" | tail -1)
      
      if [ -n "$commit" ]; then
        echo "Keeping commit $commit by $author on $date"
        
        # Save commit info for later processing
        # Use base64 encoding to safely handle special characters in author names
        timestamp=$(git log -1 --format='%at' "$commit")
        echo "$timestamp $commit $(echo "$author" | base64) $date" >> "$work_dir/commits_to_keep.txt"
        
        # Increment counter safely
        if [ -f "$work_dir/total_kept.txt" ]; then
          total_kept=$(cat "$work_dir/total_kept.txt")
          total_kept=$((total_kept + 1))
        else
          total_kept=1
        fi
        echo "$total_kept" > "$work_dir/total_kept.txt"
        
        echo "Total commits so far: $total_kept"
      else
        echo "No commit found for $author on $date"
      fi
    done
    
    echo "Finished processing author: $author"
  done
  
  # Read saved count
  if [ -f "$work_dir/total_kept.txt" ]; then
    total_kept=$(cat "$work_dir/total_kept.txt")
  else
    total_kept=0
  fi
  
  print_success "Total commits to keep: $total_kept"
  
  # Sort commits by timestamp (oldest first)
  if [ -f "$work_dir/commits_to_keep.txt" ]; then
    sort -n "$work_dir/commits_to_keep.txt" > "$work_dir/commits_sorted.txt"
    mv "$work_dir/commits_sorted.txt" "$work_dir/commits_to_keep.txt"
    echo "Sorted $total_kept commits by date"
  else
    print_error "commits_to_keep.txt not found"
    return 1
  fi
  
  # Debug check
  echo "First few commits to keep:"
  head -n 5 "$work_dir/commits_to_keep.txt"
  echo "Total lines in commits file: $(wc -l < "$work_dir/commits_to_keep.txt")"
  
  # Now create the new orphan branch
  print_header "Creating new orphan branch..."
  git checkout --orphan $SQUASHED_BRANCH
  git rm -rf .
  
  # SAFETY CHECK: Make sure we're still in a git repository
  if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "CRITICAL ERROR: Lost git repository reference after checkout. Aborting."
    return 1
  fi
  
  # Create the new history
  if [ -f "$work_dir/commits_to_keep.txt" ] && [ -s "$work_dir/commits_to_keep.txt" ]; then
    parent=""
    commit_count=0
    
    print_header "Creating new commit history..."
    
    while read -r line; do
      if [ -z "$line" ]; then
        echo "Skipping empty line"
        continue
      fi
      
      # Extract fields from line
      timestamp=$(echo "$line" | awk '{print $1}')
      commit=$(echo "$line" | awk '{print $2}')
      encoded_author=$(echo "$line" | awk '{print $3}')
      date=$(echo "$line" | awk '{print $4}')
      
      # Decode the author name from base64
      author=$(echo "$encoded_author" | base64 --decode)
      
      # Get the commit message
      message=$(git log -1 --format='%s' "$commit")
      
      # Get the tree hash (snapshot of files)
      tree=$(git log -1 --format='%T' "$commit")
      
      # Get author email
      email=$(git log -1 --format='%ae' "$commit")
      
      # Get author date format
      author_date=$(git log -1 --format='%ad' "$commit")
      
      # Get committer information
      committer_name=$(git log -1 --format='%cn' "$commit")
      committer_email=$(git log -1 --format='%ce' "$commit")
      committer_date=$(git log -1 --format='%cd' "$commit")
      
      echo "Creating commit $((commit_count + 1))/$total_kept: $commit - $author - $date - $message"
      
      # Create new commit with the same tree
      if [ -z "$parent" ]; then
        # First commit has no parent
        new_commit=$(GIT_AUTHOR_NAME="$author" \
          GIT_AUTHOR_EMAIL="$email" \
          GIT_AUTHOR_DATE="$author_date" \
          GIT_COMMITTER_NAME="$committer_name" \
          GIT_COMMITTER_EMAIL="$committer_email" \
          GIT_COMMITTER_DATE="$committer_date" \
          git commit-tree "$tree" -m "$message")
      else
        # Subsequent commits have the previous one as parent
        new_commit=$(GIT_AUTHOR_NAME="$author" \
          GIT_AUTHOR_EMAIL="$email" \
          GIT_AUTHOR_DATE="$author_date" \
          GIT_COMMITTER_NAME="$committer_name" \
          GIT_COMMITTER_EMAIL="$committer_email" \
          GIT_COMMITTER_DATE="$committer_date" \
          git commit-tree "$tree" -p "$parent" -m "$message")
      fi
      
      # Save this commit as the parent for the next one
      parent="$new_commit"
      commit_count=$((commit_count + 1))
      
      # Show progress more frequently
      if [ $((commit_count % 10)) -eq 0 ]; then
        echo "Progress: $commit_count/$total_kept commits"
      fi
    done < "$work_dir/commits_to_keep.txt"
    
    print_success "Finished creating $commit_count new commits"
    
    # Update the branch reference to point to the last commit
    if [ -n "$parent" ]; then
      git update-ref refs/heads/$SQUASHED_BRANCH "$parent"
      print_success "Created new branch with $commit_count commits"
    else
      print_error "No commits were created"
      return 1
    fi
  else
    print_error "No commits to keep were found or file is empty"
    ls -la "$work_dir"
    return 1
  fi
  
  # Checkout the new branch to make it active
  git checkout $SQUASHED_BRANCH
  
  # SAFETY CHECK: Make sure we're still in a git repository
  if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "CRITICAL ERROR: Lost git repository reference after checkout. Aborting."
    return 1
  fi
  
  # Verify the results
  print_header "SQUASHING COMPLETE!"
  echo "New branch '$SQUASHED_BRANCH' created."
  echo "Number of commits in original branch: $(git rev-list --count "$original_branch")"
  new_commit_count=$(git rev-list --count HEAD)
  echo "Number of commits in squashed branch: $new_commit_count"
  authors_count=$(git log --format='%an' | sort -u | wc -l | tr -d ' ')
  echo "Number of unique authors: $authors_count"
  
  # Verify that we have at least one commit per author
  echo "Checking for at least one commit per author..."
  git log --format='%an' | sort | uniq -c | sort -nr | head -20
  
  return 0
}

############################
# SLIMMING IMPLEMENTATION #
############################

slim_repository() {
  print_header "SLIMMING REPOSITORY"
  
  # Check if source squashed branch exists
  if ! git show-ref --verify --quiet refs/heads/$SQUASHED_BRANCH; then
    print_error "$SQUASHED_BRANCH branch does not exist. Run squash step first."
    return 1
  fi
  
  # Check if target slim branch exists
  if git show-ref --verify --quiet refs/heads/$SLIM_BRANCH; then
    print_warning "Branch $SLIM_BRANCH already exists. Do you want to overwrite it? (y/n)"
    read answer
    if [ "$answer" != "y" ]; then
      print_warning "Slimming cancelled."
      return 1
    fi
    git branch -D $SLIM_BRANCH
  fi
  
  # First, make sure we're on the squashed branch
  git checkout $SQUASHED_BRANCH
  echo "Switched to branch $SQUASHED_BRANCH"
  
  # SAFETY CHECK: Make sure we're still in a git repository
  if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "CRITICAL ERROR: Lost git repository reference after checkout. Aborting."
    return 1
  fi
  
  # Create a minimal README to use for all commits
  cat > "$work_dir/README.md" << EOF
# Repository History

This repository contains commit history with minimal content.

The actual file contents have been removed to reduce repository size while preserving:
- Commit history
- Author attribution
- Commit dates
- GitHub contribution graphs

This is a slimmed version of the full repository.
EOF
  
  # Get all commits from the squashed branch in chronological order
  print_header "Collecting commits from $SQUASHED_BRANCH branch..."
  commits=$(git log --reverse --format='%H' $SQUASHED_BRANCH)
  total_commits=$(echo "$commits" | wc -l | tr -d ' ')
  print_success "Found $total_commits commits to process"
  
  # SAFER APPROACH: Use git commit-tree instead of git commit
  # This is safer as it doesn't involve manipulating the working directory
  print_header "Creating new slim history using commit-tree (this is safer)..."
  
  # Create a simple blob for our README - use exact syntax
  readme_blob=$(git hash-object -w "$work_dir/README.md")
  echo "Created README blob: $readme_blob"
  
  # Create a tree with just our README - use a different approach that's more reliable
  # Create a temporary index file
  export GIT_INDEX_FILE="$work_dir/temp_index"
  git read-tree --empty  # Start with an empty index
  git update-index --add --cacheinfo 100644 "$readme_blob" "README.md"
  tree_with_readme=$(git write-tree)
  echo "Created tree with README: $tree_with_readme"
  
  # Verify the tree was created correctly
  if [ -z "$tree_with_readme" ]; then
    print_error "Failed to create tree with README.md"
    return 1
  fi
  
  parent=""
  commit_count=0
  
  echo "$commits" | while read -r commit; do
    # Get commit details
    author_name=$(git log -1 --format='%an' "$commit")
    author_email=$(git log -1 --format='%ae' "$commit")
    author_date=$(git log -1 --format='%ad' "$commit")
    committer_name=$(git log -1 --format='%cn' "$commit")
    committer_email=$(git log -1 --format='%ce' "$commit")
    committer_date=$(git log -1 --format='%cd' "$commit")
    commit_message=$(git log -1 --format='%B' "$commit")
    
    echo "Processing commit $((commit_count + 1))/$total_commits: $commit - $author_name"
    
    # Create new commit with the same metadata but minimal content
    if [ -z "$parent" ]; then
      # First commit has no parent
      new_commit=$(
        GIT_AUTHOR_NAME="$author_name" \
        GIT_AUTHOR_EMAIL="$author_email" \
        GIT_AUTHOR_DATE="$author_date" \
        GIT_COMMITTER_NAME="$committer_name" \
        GIT_COMMITTER_EMAIL="$committer_email" \
        GIT_COMMITTER_DATE="$committer_date" \
        git commit-tree "$tree_with_readme" -m "$commit_message"
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
        git commit-tree "$tree_with_readme" -p "$parent" -m "$commit_message"
      )
    fi
    
    # Verify the commit was created successfully
    if [ -z "$new_commit" ]; then
      print_error "Failed to create commit for $commit"
      continue  # Try to continue with the next commit
    fi
    
    echo "Created new commit: $new_commit"
    
    # Save for next iteration
    parent="$new_commit"
    
    # Save the last commit to create our branch later
    echo "$new_commit" > "$work_dir/last_commit.txt"
    
    commit_count=$((commit_count + 1))
    
    # Show progress
    if [ $((commit_count % 20)) -eq 0 ]; then
      echo "Progress: $commit_count/$total_commits commits"
    fi
  done
  
  # Clean up custom index file
  unset GIT_INDEX_FILE
  rm -f "$work_dir/temp_index"
  
  # Create the new branch pointing to the last commit
  if [ -f "$work_dir/last_commit.txt" ] && [ -s "$work_dir/last_commit.txt" ]; then
    last_commit=$(cat "$work_dir/last_commit.txt")
    if [ -n "$last_commit" ]; then
      print_success "Creating $SLIM_BRANCH branch pointing to $last_commit"
      git branch $SLIM_BRANCH "$last_commit"
      print_success "Branch created successfully"
    else
      print_error "No commits were created (last_commit.txt is empty)"
      return 1
    fi
  else
    print_error "last_commit.txt not found or empty"
    echo "Contents of work directory:"
    ls -la "$work_dir"
    return 1
  fi
  
  # Checkout the new branch to make it active
  print_header "Checking out $SLIM_BRANCH branch..."
  git checkout $SLIM_BRANCH
  
  # SAFETY CHECK: Make sure we're still in a git repository
  if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "CRITICAL ERROR: Lost git repository reference after checkout. Aborting."
    return 1
  fi
  
  # Verify the results
  print_header "REPOSITORY SLIMMING COMPLETE!"
  print_success "New branch '$SLIM_BRANCH' created."
  new_commit_count=$(git rev-list --count HEAD)
  echo "Number of commits in slim branch: $new_commit_count"
  authors_count=$(git log --format='%an' | sort -u | wc -l | tr -d ' ')
  echo "Number of unique authors: $authors_count"
  
  echo ""
  echo "Repository size comparison:"
  git checkout $SQUASHED_BRANCH
  squashed_size=$(du -sh .git | cut -f1)
  echo "Size of $SQUASHED_BRANCH branch: $squashed_size"
  git checkout $SLIM_BRANCH
  slim_size=$(du -sh .git | cut -f1)
  echo "Size of $SLIM_BRANCH branch: $slim_size"
  
  return 0
}

# Main execution flow
main() {
  print_header "REPOSITORY OPTIMIZER STARTING"
  
  if $PERFORM_SQUASH; then
    if ! squash_repository; then
      print_error "Squashing failed."
      # Return to original branch
      git checkout "$original_branch" 2>/dev/null || true
      return 1
    fi
  else
    print_warning "Skipping squash step as requested."
  fi
  
  if $PERFORM_SLIM; then
    if ! slim_repository; then
      print_error "Slimming failed."
      # Return to original branch
      git checkout "$original_branch" 2>/dev/null || true
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
    echo "To create a new slimmed repository:"
    echo "  mkdir ../slim-repo"
    echo "  cd ../slim-repo"
    echo "  git init"
    echo "  git fetch <path_to_original_repo> $SLIM_BRANCH:main"
    echo "  git checkout main"
    echo ""
  fi
  
  echo "To switch back to your original branch:"
  echo "  git checkout $original_branch"
  
  # Return to original branch
  print_header "Returning to original branch"
  git checkout "$original_branch"
  
  return 0
}

# Run the main function
main

# If we got here, everything was successful
print_success "PROCESS COMPLETED SUCCESSFULLY" 