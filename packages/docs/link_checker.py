#!/usr/bin/env python3
"""
Link Checker and Fixer for elizaOS Documentation
Scans MDX files for broken links and applies automatic fixes
"""

import os
import re
import json
import requests
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Set
from urllib.parse import urljoin, urlparse
import difflib
import time

class LinkChecker:
    def __init__(self, docs_dir: str = "."):
        self.docs_dir = Path(docs_dir)
        self.fixes_applied = []
        self.broken_links = []
        self.external_cache = {}
        self.file_list = []
        self.nav_structure = {}
        
        # Load navigation structure from docs.json
        docs_json_path = self.docs_dir / "docs.json"
        if docs_json_path.exists():
            with open(docs_json_path) as f:
                self.nav_structure = json.load(f)
        
        # Build file list
        self.build_file_list()
    
    def build_file_list(self):
        """Build a list of all MDX files and their paths"""
        for file_path in self.docs_dir.rglob("*.mdx"):
            relative_path = file_path.relative_to(self.docs_dir)
            # Convert file path to URL path (remove .mdx extension)
            url_path = "/" + str(relative_path).replace(".mdx", "")
            self.file_list.append({
                "file_path": file_path,
                "url_path": url_path,
                "relative_path": relative_path
            })
    
    def extract_links(self, content: str) -> List[Dict]:
        """Extract all links from MDX content"""
        links = []
        
        # Pattern for markdown links [text](url)
        markdown_pattern = r'\[([^\]]*)\]\(([^)]+)\)'
        for match in re.finditer(markdown_pattern, content):
            links.append({
                "text": match.group(1),
                "url": match.group(2),
                "type": "markdown",
                "start": match.start(),
                "end": match.end(),
                "full_match": match.group(0)
            })
        
        # Pattern for href attributes in components
        href_pattern = r'href=["\']([^"\']+)["\']'
        for match in re.finditer(href_pattern, content):
            links.append({
                "text": "",
                "url": match.group(1),
                "type": "href",
                "start": match.start(),
                "end": match.end(),
                "full_match": match.group(0)
            })
        
        # Pattern for src attributes in images
        src_pattern = r'src=["\']([^"\']+)["\']'
        for match in re.finditer(src_pattern, content):
            links.append({
                "text": "",
                "url": match.group(1),
                "type": "src",
                "start": match.start(),
                "end": match.end(),
                "full_match": match.group(0)
            })
        
        return links
    
    def classify_link(self, url: str) -> str:
        """Classify link type"""
        if url.startswith("#"):
            return "anchor"
        elif url.startswith("http://") or url.startswith("https://"):
            return "external"
        elif url.startswith("/"):
            return "internal_absolute"
        elif url.startswith("./") or url.startswith("../"):
            return "internal_relative"
        else:
            return "unknown"
    
    def check_internal_link(self, url: str) -> Tuple[bool, Optional[str]]:
        """Check if internal link exists and suggest fixes"""
        # Remove anchor part for file existence check
        file_path = url.split("#")[0]
        
        # Check if file exists directly
        for file_info in self.file_list:
            if file_info["url_path"] == file_path:
                return True, None
        
        # Check for common variations
        candidates = []
        for file_info in self.file_list:
            # Calculate similarity
            similarity = difflib.SequenceMatcher(None, file_path, file_info["url_path"]).ratio()
            if similarity > 0.85:  # 85% similarity threshold
                candidates.append((file_info["url_path"], similarity))
        
        if candidates:
            # Sort by similarity and return best match
            candidates.sort(key=lambda x: x[1], reverse=True)
            return False, candidates[0][0]
        
        return False, None
    
    def check_external_link(self, url: str) -> Tuple[bool, Optional[str]]:
        """Check if external link is valid"""
        if url in self.external_cache:
            return self.external_cache[url]
        
        # Skip checking certain domains
        skip_domains = [
            "localhost",
            "127.0.0.1",
            "example.com",
            "test.com",
            "placeholder.com"
        ]
        
        parsed = urlparse(url)
        if parsed.hostname in skip_domains:
            self.external_cache[url] = (True, None)
            return True, None
        
        try:
            response = requests.head(url, timeout=10, allow_redirects=True)
            if response.status_code < 400:
                self.external_cache[url] = (True, None)
                return True, None
            else:
                self.external_cache[url] = (False, f"HTTP {response.status_code}")
                return False, f"HTTP {response.status_code}"
        except Exception as e:
            self.external_cache[url] = (False, str(e))
            return False, str(e)
    
    def check_file_links(self, file_path: Path) -> List[Dict]:
        """Check all links in a file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception as e:
            return [{"error": f"Could not read file: {e}"}]
        
        links = self.extract_links(content)
        results = []
        
        for link in links:
            url = link["url"]
            link_type = self.classify_link(url)
            
            result = {
                "file": str(file_path),
                "link": link,
                "link_type": link_type,
                "valid": True,
                "suggestion": None,
                "confidence": "high"
            }
            
            if link_type == "internal_absolute":
                valid, suggestion = self.check_internal_link(url)
                result["valid"] = valid
                result["suggestion"] = suggestion
                if suggestion:
                    result["confidence"] = "high" if difflib.SequenceMatcher(None, url, suggestion).ratio() > 0.9 else "medium"
            
            elif link_type == "external":
                valid, error = self.check_external_link(url)
                result["valid"] = valid
                result["error"] = error
                if not valid:
                    result["confidence"] = "low"  # External links need manual review
            
            elif link_type == "anchor":
                # For now, skip anchor checking within documents
                result["valid"] = True
                result["confidence"] = "high"
            
            results.append(result)
        
        return results
    
    def apply_fix(self, file_path: Path, link_result: Dict) -> bool:
        """Apply a fix to a broken link"""
        if link_result["valid"] or not link_result["suggestion"]:
            return False
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception as e:
            return False
        
        link = link_result["link"]
        old_url = link["url"]
        new_url = link_result["suggestion"]
        
        # Replace the URL in the content
        if link["type"] == "markdown":
            old_link = f'[{link["text"]}]({old_url})'
            new_link = f'[{link["text"]}]({new_url})'
            new_content = content.replace(old_link, new_link)
        elif link["type"] == "href":
            old_href = f'href="{old_url}"'
            new_href = f'href="{new_url}"'
            new_content = content.replace(old_href, new_href)
        else:
            return False
        
        # Only apply if content changed
        if new_content != content:
            try:
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                
                # Track the fix
                self.fixes_applied.append({
                    "file": str(file_path),
                    "old_url": old_url,
                    "new_url": new_url,
                    "confidence": link_result["confidence"],
                    "type": link_result["link_type"]
                })
                return True
            except Exception as e:
                return False
        
        return False
    
    def check_all_links(self) -> Dict:
        """Check all links in all MDX files"""
        results = {
            "total_files": 0,
            "total_links": 0,
            "broken_links": 0,
            "fixed_links": 0,
            "files_modified": 0,
            "detailed_results": []
        }
        
        mdx_files = list(self.docs_dir.rglob("*.mdx"))
        results["total_files"] = len(mdx_files)
        
        for file_path in mdx_files:
            print(f"Checking links in: {file_path}")
            file_results = self.check_file_links(file_path)
            
            file_broken = 0
            file_fixed = 0
            
            for link_result in file_results:
                if "error" in link_result:
                    continue
                
                results["total_links"] += 1
                
                if not link_result["valid"]:
                    results["broken_links"] += 1
                    file_broken += 1
                    self.broken_links.append(link_result)
                    
                    # Apply fix if confidence is high or medium
                    if link_result["confidence"] in ["high", "medium"] and link_result["suggestion"]:
                        if self.apply_fix(file_path, link_result):
                            results["fixed_links"] += 1
                            file_fixed += 1
            
            if file_fixed > 0:
                results["files_modified"] += 1
            
            results["detailed_results"].append({
                "file": str(file_path),
                "results": file_results,
                "broken_count": file_broken,
                "fixed_count": file_fixed
            })
        
        return results
    
    def generate_report(self, results: Dict) -> str:
        """Generate a summary report"""
        report = f"""# Link Checking Report

## Summary
- **Total files checked**: {results['total_files']}
- **Total links found**: {results['total_links']}
- **Broken links found**: {results['broken_links']}
- **Links fixed automatically**: {results['fixed_links']}
- **Files modified**: {results['files_modified']}

## Fixes Applied
"""
        
        for fix in self.fixes_applied:
            report += f"- **{fix['file']}**: `{fix['old_url']}` → `{fix['new_url']}` (confidence: {fix['confidence']})\n"
        
        report += f"""
## Remaining Broken Links
"""
        
        remaining_broken = [link for link in self.broken_links if not any(
            fix["old_url"] == link["link"]["url"] and fix["file"] == link["file"]
            for fix in self.fixes_applied
        )]
        
        for link in remaining_broken:
            report += f"- **{link['file']}**: `{link['link']['url']}` ({link['link_type']})\n"
        
        return report

def main():
    """Main function to run the link checker"""
    checker = LinkChecker()
    
    print("Starting link check...")
    results = checker.check_all_links()
    
    print(f"\n✅ Link check complete!")
    print(f"📊 Total files: {results['total_files']}")
    print(f"🔗 Total links: {results['total_links']}")
    print(f"❌ Broken links: {results['broken_links']}")
    print(f"✅ Fixed links: {results['fixed_links']}")
    print(f"📝 Files modified: {results['files_modified']}")
    
    # Generate report
    report = checker.generate_report(results)
    with open("link_check_report.md", "w") as f:
        f.write(report)
    
    # Save detailed results as JSON
    with open("link_check_results.json", "w") as f:
        json.dump({
            "summary": results,
            "fixes_applied": checker.fixes_applied,
            "broken_links": checker.broken_links
        }, f, indent=2)
    
    print(f"\n📋 Report saved to: link_check_report.md")
    print(f"📋 Detailed results saved to: link_check_results.json")

if __name__ == "__main__":
    main()