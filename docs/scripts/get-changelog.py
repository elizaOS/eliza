#!/usr/bin/env python3
"""
Script to fetch, clean up, and format a GitHub-generated changelog for Docusaurus.
This script:
1. Fetches ONLY NEW release information from GitHub API
2. Processes them with consistent formatting
3. Appends the new releases to the existing changelog
4. Ensures proper formatting for Docusaurus navigation
"""

import re
import sys
import os
import json
import requests
from datetime import datetime
from pathlib import Path
import argparse

def fetch_releases(repo, token=None, since_version=None):
    """
    Fetch releases from GitHub API
    If since_version is provided, only returns releases newer than that version
    """
    headers = {}
    if token:
        headers["Authorization"] = f"token {token}"
    
    url = f"https://api.github.com/repos/{repo}/releases"
    response = requests.get(url, headers=headers)
    
    if response.status_code != 200:
        print(f"Error fetching releases: {response.status_code}")
        print(response.text)
        sys.exit(1)
    
    releases = response.json()
    
    # If since_version is provided, filter out older releases
    if since_version:
        # Clean version string for comparison
        since_version = since_version.lstrip('v')
        filtered_releases = []
        
        for release in releases:
            tag_name = release.get("tag_name", "").lstrip('v')
            
            # If we can't determine the ordering or we hit our since_version, stop
            if not tag_name or tag_name == since_version:
                break
                
            filtered_releases.append(release)
            
        return filtered_releases
    
    return releases

def extract_latest_version(changelog_content):
    """Extract the most recent version from the existing changelog"""
    version_match = re.search(r'## (v[\d\.]+-?[a-zA-Z\d.]*)', changelog_content)
    if version_match:
        return version_match.group(1)
    return None

def process_release(release):
    """Generate formatted content for a single release"""
    content = ""
    
    name = release.get("name", release.get("tag_name", "Unknown"))
    published_date = release.get("published_at", "")
    
    if published_date:
        try:
            date_obj = datetime.strptime(published_date, "%Y-%m-%dT%H:%M:%SZ")
            date_str = date_obj.strftime("%B %d, %Y")
            content += f"## {name} ({date_str})\n\n"
        except ValueError:
            content += f"## {name}\n\n"
    else:
        content += f"## {name}\n\n"
    
    body = release.get("body", "")
    
    # Clean up the body content
    processed_body = process_content_block(body)
    content += processed_body
    content += "\n\n---\n\n"
    
    return content

def process_content_block(content):
    """Process and format a block of changelog content"""
    # First, let's make sure we have a clean slate by removing any existing HTML tags
    content = re.sub(r'<[^>]*>', '', content)
    
    # Remove template variables like {{maxTweetLength}}
    content = re.sub(r'{{[^}]*}}', '', content)
    
    # Replace specific problematic strings - handle the maxTweetLength issue
    content = content.replace('- {{maxTweetLength}} doesn\'t work in tweet post template', '- maxTweetLength doesn\'t work in tweet post template')
    
    # Normalize line endings
    content = content.replace('\r\n', '\n')
    
    # Make "What's Changed" and similar headings as H4 (not H3)
    def header_replacement(match):
        return f"#### {match.group(1)}"
        
    # Process common section headers
    section_headers = [
        r'^## (What\'s Changed.*?)$',
        r'^## (Features.*?)$', 
        r'^## (Fixes.*?)$',
        r'^## (Chores.*?)$',
        r'^## (Documentation.*?)$',
        r'^## (Tests.*?)$',
        r'^## (Other.*?)$',
        r'^## (Major changes.*?)$',
        r'^## (New Features.*?)$',
        r'^## (New Fixes.*?)$',
        r'^## (New Contributors.*?)$'
    ]
    
    for pattern in section_headers:
        content = re.sub(pattern, header_replacement, content, flags=re.MULTILINE)
    
    # Convert any remaining ## headers to #### (that aren't what we've already matched)
    content = re.sub(r'^## ([^#].*)$', header_replacement, content, flags=re.MULTILINE)
    
    # Convert any ### headers to #### as well
    content = re.sub(r'^### ([^#].*)$', header_replacement, content, flags=re.MULTILINE)
    
    # Convert any level 1 headers to level 4
    content = re.sub(r'^# ([^#].*)$', header_replacement, content, flags=re.MULTILINE)
    
    # Add spacing after section headers (#### headers)
    content = re.sub(r'^(#### .+)$', r'\1\n', content, flags=re.MULTILINE)
    
    # Process "New Contributors" sections
    if "## New Contributors" in content:
        # First remove any empty ## headers that might be present
        content = re.sub(r'\n##\s*\n', '\n', content)
        
        # Split the content at the New Contributors section
        parts = content.split("## New Contributors", 1)
        main_content = parts[0].rstrip()  # Remove trailing whitespace
        contributors_content = parts[1].split("**Full Changelog**", 1)
        
        # Extract the contributors list without the header
        contributors_section = contributors_content[0].strip()
        
        # Create formatted header with collapsible details
        contributors_formatted = "## New Contributors\n\n<details>\n<summary>View New Contributors</summary>\n\n" + contributors_section + "\n</details>\n"
        
        # Add Full Changelog part back if it exists, with proper spacing
        if len(contributors_content) > 1:
            # Format the Full Changelog with appropriate spacing
            changelog_part = contributors_content[1].strip()
            
            # Check if it begins with a colon and add space after it
            if changelog_part.startswith(":"):
                changelog_part = changelog_part[1:].strip()
            
            contributors_formatted += "\n\n#### Full Changelog: " + changelog_part + "\n\n"
        
        content = main_content + contributors_formatted
    
    # Ensure bullet points are properly formatted
    content = re.sub(r'^\s*\*\s+', '* ', content, flags=re.MULTILINE)
    
    # Ensure links are properly formatted
    content = re.sub(r'\[([^\]]+)\]\((https://[^\)]+)\)', r'[\1](\2)', content)
    
    # Clean up excessive newlines
    content = re.sub(r'\n{3,}', '\n\n', content)
    
    # Fix header spacing
    content = re.sub(r'^(#### .+)\n(?!\n)', r'\1\n\n', content, flags=re.MULTILINE)
    
    # One more pass to fix any remaining "$1" issues that might have escaped our regex replacements
    content = content.replace("#### $1", "#### Changes")
    
    return content.strip()

def main():
    parser = argparse.ArgumentParser(description='Append new releases to an existing changelog from GitHub')
    parser.add_argument('--repo', default='elizaOS/eliza', help='GitHub repository in format owner/repo')
    parser.add_argument('--token', help='GitHub personal access token')
    parser.add_argument('--output', default='docs/changelog.md', help='Output file path')
    parser.add_argument('--force-rebuild', action='store_true', help='Rebuild the entire changelog instead of just appending')
    
    args = parser.parse_args()
    
    # Check if the changelog file exists
    output_path = Path(args.output)
    existing_content = ""
    latest_version = None
    
    if output_path.exists() and not args.force_rebuild:
        try:
            with open(output_path, 'r', encoding='utf-8') as f:
                existing_content = f.read()
                latest_version = extract_latest_version(existing_content)
                print(f"Found existing changelog with latest version: {latest_version}")
        except Exception as e:
            print(f"Error reading existing changelog: {e}")
            print("Falling back to rebuilding the entire changelog")
            args.force_rebuild = True
    
    # Fetch releases from GitHub
    token = args.token or os.environ.get('GITHUB_TOKEN')
    
    if args.force_rebuild or not existing_content:
        print("Fetching all releases...")
        releases = fetch_releases(args.repo, token)
        
        # Generate a full changelog
        content = "# Changelog\n\n"
        for release in releases:
            content += process_release(release)
    else:
        print(f"Fetching releases newer than {latest_version}...")
        new_releases = fetch_releases(args.repo, token, latest_version)
        
        if not new_releases:
            print("No new releases found. Changelog is already up to date.")
            return
            
        print(f"Found {len(new_releases)} new releases to add")
        
        # Generate content for new releases
        new_content = ""
        for release in new_releases:
            new_content += process_release(release)
        
        # If existing content doesn't start with the Changelog title, we'll add it
        if not existing_content.startswith("# Changelog"):
            content = "# Changelog\n\n" + new_content + existing_content
        else:
            # Otherwise, insert after the title
            title_match = re.search(r'# Changelog\s*\n\s*\n', existing_content)
            if title_match:
                insertion_point = title_match.end()
                content = existing_content[:insertion_point] + new_content + existing_content[insertion_point:]
            else:
                # Fallback
                content = "# Changelog\n\n" + new_content + existing_content
    
    # Write the updated content to the output file
    with open(args.output, 'w', encoding='utf-8') as f:
        f.write(content)
    
    if args.force_rebuild or not existing_content:
        print(f"Complete changelog rebuilt and saved to {args.output}")
    else:
        print(f"Changelog updated with {len(new_releases)} new releases and saved to {args.output}")

if __name__ == "__main__":
    main()
