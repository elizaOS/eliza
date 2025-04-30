import os
import json
import time
import requests
import re
import yaml
from pathlib import Path

# OpenRouter API configuration
OPENAI_API_KEY = ""  # Replace with your actual API key
BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "perplexity/sonar-reasoning-pro:online"  # Using the online variant for web search

# Headers for API requests
headers = {
    "Authorization": f"Bearer {OPENAI_API_KEY}",
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/elizaos/knowledge",  # Replace with your actual repo
    "X-Title": "ElizaOS Partner Research"
}

def extract_frontmatter(content):
    """Extract front matter from markdown content."""
    front_matter_dict = {}
    raw_front_matter_block = ""
    main_content = content # Default to full content

    if content.startswith('---'):
        parts = content.split('---', 2)
        if len(parts) >= 3:
            raw_front_matter_block = f"---{parts[1]}---" # Keep the raw block including delimiters
            try:
                # Parse the YAML front matter into a dict
                front_matter_dict = yaml.safe_load(parts[1])
                if not isinstance(front_matter_dict, dict):
                     # Handle cases where frontmatter is not a proper dictionary (e.g., just a string)
                     print(f"Warning: Frontmatter parsed, but is not a dictionary: {type(front_matter_dict)}")
                     front_matter_dict = {} # Reset to empty dict
                main_content = parts[2].strip()
            except Exception as e:
                print(f"Error parsing front matter YAML: {e}. Keeping raw block.")
                # If parsing fails, keep the raw block but reset dict and use content after second ---
                front_matter_dict = {}
                main_content = parts[2].strip()
        else:
            # Only one --- found, treat as content
             main_content = content
    
    # Return the raw block, the parsed dict (best effort), and the main content
    return raw_front_matter_block, front_matter_dict, main_content

def read_partner_info(partner_path):
    """Read the existing index.md file for a partner."""
    index_path = partner_path / "index.md"
    if index_path.exists():
        with open(index_path, "r", encoding="utf-8") as f:
            full_content = f.read()
            raw_fm_block, fm_dict, main_content = extract_frontmatter(full_content)
            return {
                "raw_front_matter": raw_fm_block,
                "front_matter_dict": fm_dict, # Parsed dictionary
                "content": main_content, # Content after frontmatter
                "full_content": full_content # Original full content
            }
    return {"raw_front_matter": "", "front_matter_dict": {}, "content": "", "full_content": ""}

def research_partner(partner_name, partner_info):
    """Use SonarReasoningPro to research the partner and generate detailed information."""
    front_matter = partner_info.get("front_matter_dict", {})
    content = partner_info.get("content", "")
    
    # Create context from existing information
    description = front_matter.get('description', '')
    website = front_matter.get('website', '')
    twitter = front_matter.get('twitter', '')
    tags = ', '.join(front_matter.get('tags', []))
    
    # Plugin search context - relying on model's web search capability
    plugin_context = f"""
    When researching the integration, please also investigate if there might be an official ElizaOS plugin for {partner_name}.
    Consider looking for resources associated with ElizaOS plugins, such as repositories within the elizaos-plugins organization on GitHub.

    If you find relevant plugin information (like its purpose from a README or description), please summarize it in the 'Integration with Eliza' section.
    """

    prompt = f"""
I need comprehensive, factual information about {partner_name}, who is a partner of ElizaOS.
Here's what I currently have about them:

Description: {description}
Website: {website}
Twitter: {twitter}
Tags: {tags}

Original content: 
{content}

{plugin_context}

Please research this company/project and provide detailed, factual information for these sections:

1. ## About {partner_name}
   - A detailed introduction to what they do
   - Their main products/services
   - Their significance in the Web3/blockchain space

2. ## Technology
   - Their technology stack and innovations
   - Technical approach and how their technology works
   - What problems their technology solves

3. ## Key Features
   - 5-7 specific, enhanced bullet points about their key features and advantages
   - Technical capabilities and differentiators
   
4. ## Integration with Eliza
   - Specific details on how their technology integrates with elizaOS
   - Technical synergies and use cases for the partnership
   - Potential benefits for users of both platforms

5. ## Recent Developments
   - Latest news, updates, or milestones (within the last year)
   - Roadmap items or future plans that have been publicly announced
   
6. ## Market Position
   - Their position compared to competitors
   - Key partnerships besides ElizaOS
   - User base or adoption metrics if available

7. ## Links
   - Website, documentation, GitHub, social media, etc.

Important: Please DO NOT include citation markers like [1] or [2][3] in your response. 
Instead, integrate the information naturally without citation numbers.
Focus on factual information from reputable sources. Include specific technical details where available.
"""

    # API request payload
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "web_search_options": {
            "search_context_size": "high"  # Use high search context for comprehensive research
        }
    }

    try:
        response = requests.post(BASE_URL, headers=headers, json=payload)
        response.raise_for_status()
        result = response.json()
        
        # Extract the research content from the response
        if 'choices' in result and len(result['choices']) > 0:
            report = result['choices'][0]['message']['content']
            return report
        else:
            return f"Error: No content returned for {partner_name}"
            
    except Exception as e:
        return f"Error researching {partner_name}: {str(e)}"

def create_brief_markdown(partner_info, research_results):
    """Create a brief markdown file with just the most important sections."""
    # Use the parsed dict to get specific values
    front_matter_dict = partner_info.get("front_matter_dict", {})
    
    # Extract the title from frontmatter or content
    title_text = front_matter_dict.get('title', '')
    title_heading = f"# {title_text}" if title_text else ""
    
    # Extract sections from research results using regex
    about_match = re.search(r'## About [^\n]+\n(.*?)(?=\n##|$)', research_results, re.DOTALL)
    about = about_match.group(1).strip() if about_match else ""
    
    integration_match = re.search(r'## Integration with Eliza\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    integration = integration_match.group(1).strip() if integration_match else ""
    
    recent_match = re.search(r'## Recent Developments\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    recent = recent_match.group(1).strip() if recent_match else ""
    
    market_match = re.search(r'## Market Position\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    market = market_match.group(1).strip() if market_match else ""
    
    # Clean any citation markers that might have been missed in the instruction
    def clean_citations(text):
        pattern = r'\[\d+\](?:\[\d+\])*'
        cleaned_text = re.sub(pattern, '', text)
        cleaned_text = re.sub(r'  +', ' ', cleaned_text)
        return cleaned_text
    
    about = clean_citations(about)
    integration = clean_citations(integration)
    recent = clean_citations(recent)
    market = clean_citations(market)
    
    # Build the brief markdown
    brief_markdown = f"""
{title_heading}

## About {title_text}

{about}

## Integration with Eliza

{integration}

## Recent Developments

{recent}

## Market Position

{market}
"""
    
    return brief_markdown.strip() + "\n" # Ensure single trailing newline

def save_brief_markdown(partner_path, brief_markdown):
    """Save the brief markdown to brief.md in the partner's folder."""
    output_path = partner_path / "brief.md"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(brief_markdown)
    return output_path

def create_enhanced_markdown(partner_info, research_results):
    """Create a new markdown file that preserves the format but enhances content."""
    # Use the raw frontmatter directly
    raw_front_matter = partner_info.get("raw_front_matter", "")
    # Use the parsed dict only to get specific values if needed
    front_matter_dict = partner_info.get("front_matter_dict", {})
    original_content = partner_info.get("content", "") # Content without frontmatter
    
    # Extract the title and logo section from the original content (after frontmatter)
    # Use the title from the parsed frontmatter as a fallback
    title_match = re.search(r'^# (.+?)(?=\n|$)', original_content, re.MULTILINE)
    title_text = title_match.group(1) if title_match else front_matter_dict.get('title', '')
    title_heading = f"# {title_text}" if title_text else ""
        
    logo_match = re.search(r'<div className="partner-logo">.*?</div>', original_content, re.DOTALL)
    logo = logo_match.group(0) if logo_match else ""
    
    # Extract the short description (single line after the logo, or from frontmatter)
    short_desc = ""
    if logo: # If logo exists, look for description after it
        desc_match = re.search(rf'{re.escape(logo)}\s*\n(.*?)(?=\n##|$)', original_content, re.DOTALL)
        if desc_match:
            short_desc = desc_match.group(1).strip()
    if not short_desc: # Fallback to frontmatter description
        short_desc = front_matter_dict.get('description', '')
    
    # Extract sections from research results using regex
    about_match = re.search(r'## About [^\n]+\n(.*?)(?=\n##|$)', research_results, re.DOTALL)
    about = about_match.group(1).strip() if about_match else ""
    
    tech_match = re.search(r'## Technology\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    tech = tech_match.group(1).strip() if tech_match else ""
    
    features_match = re.search(r'## Key Features\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    features = features_match.group(1).strip() if features_match else ""
    
    integration_match = re.search(r'## Integration with Eliza\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    integration = integration_match.group(1).strip() if integration_match else ""
    
    recent_match = re.search(r'## Recent Developments\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    recent = recent_match.group(1).strip() if recent_match else ""
    
    market_match = re.search(r'## Market Position\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    market = market_match.group(1).strip() if market_match else ""
    
    links_match = re.search(r'## Links\s*(.*?)(?=\n##|$)', research_results, re.DOTALL)
    links = links_match.group(1).strip() if links_match else ""
    
    # Convert lists to bullet points if they aren't already
    def ensure_bullet_points(text):
        lines = text.strip().split('\n')
        result = []
        
        for line in lines:
            line = line.strip()
            if line and not line.startswith('-') and not line.startswith('*'):
                if ':' in line:
                    # This might be a list item with a label
                    result.append(f"- {line}")
                elif line[0].isupper() and len(line) > 5:
                    # This looks like a complete sentence/point
                    result.append(f"- {line}")
                else:
                    # Just add the line as is
                    result.append(line)
            else:
                result.append(line)
                
        return '\n'.join(result)
    
    # Ensure features are formatted as bullet points
    if features and not re.search(r'^\s*[-*]', features, re.MULTILINE):
        features = ensure_bullet_points(features)
    
    # Build the enhanced markdown using the raw frontmatter block
    enhanced_markdown = f"""{raw_front_matter}

{title_heading}

{logo}

{short_desc}

## About {title_text}

{about}

## Technology

{tech}

## Key Features

{features}

## Integration with Eliza

{integration}

## Recent Developments

{recent}

## Market Position

{market}

## Links

{links}
"""
    
    return enhanced_markdown.strip() + "\n" # Ensure single trailing newline

def save_enhanced_markdown(partner_path, enhanced_markdown):
    """Save the enhanced markdown to index2.md in the partner's folder."""
    output_path = partner_path / "index2.md"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(enhanced_markdown)
    return output_path

def process_partners(root_dir):
    """Process all partner folders and generate enhanced markdown files."""
    root_path = Path(root_dir)
    
    # Get all directories that might be partner folders
    partner_folders = [d for d in root_path.iterdir() 
                      if d.is_dir() and (d / "index.md").exists()]
    
    results = []
    
    for partner_folder in partner_folders:
        partner_name = partner_folder.name.replace('-', ' ').title()
        print(f"Processing {partner_name}...")
        
        # Read existing partner info
        partner_info = read_partner_info(partner_folder)
        
        # Research the partner
        research_results = research_partner(partner_name, partner_info)
        
        # Create enhanced markdown
        enhanced_markdown = create_enhanced_markdown(partner_info, research_results)
        
        # Create brief markdown
        brief_markdown = create_brief_markdown(partner_info, research_results)
        
        # Save the enhanced markdown
        output_path = save_enhanced_markdown(partner_folder, enhanced_markdown)
        
        # Save the brief markdown
        brief_path = save_brief_markdown(partner_folder, brief_markdown)
        
        results.append({
            "partner": partner_name,
            "output_file": str(output_path),
            "brief_file": str(brief_path),
            "status": "Success" if len(enhanced_markdown) > 100 else "Possible Error"
        })
        
        # Add a delay to avoid rate limiting
        time.sleep(5)
    
    return results

if __name__ == "__main__":
    # The root directory of your partner folders
    ROOT_DIR = "."  # Change if your script is in a different location
    
    print("Starting ElizaOS Partner Enhancement...")
    results = process_partners(ROOT_DIR)
    
    # Output summary
    print("\nEnhancement Complete!")
    print(f"Processed {len(results)} partners:")
    
    for result in results:
        print(f"- {result['partner']}: {result['status']} -> {result['output_file']}")
