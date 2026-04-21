### More Information > https://docs.firecrawl.dev/sdks/cli

## Documentation Index
> Fetch the complete documentation index at: https://docs.firecrawl.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Skill + CLI

> Firecrawl Skill is an easy way for AI agents such as Claude Code, Antigravity and  OpenCode to use Firecrawl through the CLI.

## Installation

Install the Firecrawl CLI globally using npm:

```bash CLI theme={null}
# Install globally with npm
npm install -g firecrawl-cli
```

If you are using any AI agent like Claude Code, you can install the Firecrawl skill below and the agent will be able to set it up for you.

```bash  theme={null}
npx skills add firecrawl/cli
```

<Note>
  After installing the skill, restart Claude Code for it to discover the new skill.
</Note>

## Authentication

Before using the CLI, you need to authenticate with your Firecrawl API key.

### Login

```bash CLI theme={null}
# Interactive login (opens browser or prompts for API key)
firecrawl login

# Login with browser authentication (recommended for agents)
firecrawl login --browser

# Login with API key directly
firecrawl login --api-key fc-YOUR-API-KEY

# Or set via environment variable
export FIRECRAWL_API_KEY=fc-YOUR-API-KEY
```

### View Configuration

```bash CLI theme={null}
# View current configuration
firecrawl config
```

### Self-Hosted / Local Development

For self-hosted Firecrawl instances or local development, use the `--api-url` option:

```bash CLI theme={null}
# Use a local Firecrawl instance (no API key required)
firecrawl --api-url http://localhost:3002 scrape https://example.com

# Or set via environment variable
export FIRECRAWL_API_URL=http://localhost:3002
firecrawl scrape https://example.com

# Configure and persist the custom API URL
firecrawl config --api-url http://localhost:3002
```

When using a custom API URL (anything other than `https://api.firecrawl.dev`), API key authentication is automatically skipped, allowing you to use local instances without an API key.

### Check Status

Verify installation, authentication, and view rate limits:

```bash CLI theme={null}
firecrawl --status
```

Output when ready:

```
  🔥 firecrawl cli v1.1.1

  ● Authenticated via FIRECRAWL_API_KEY
  Concurrency: 0/100 jobs (parallel scrape limit)
  Credits: 500,000 remaining
```

* **Concurrency**: Maximum parallel jobs. Run parallel operations close to this limit but not above.
* **Credits**: Remaining API credits. Each scrape/crawl consumes credits.

## Commands

### Scrape

Scrape a single URL and extract its content in various formats.

<Tip>
  Use `--only-main-content` to get clean output without navigation, footers, and ads. This is recommended for most use cases where you want just the article or main page content.
</Tip>

```bash CLI theme={null}
# Scrape a URL (default: markdown output)
firecrawl https://example.com

# Or use the explicit scrape command
firecrawl scrape https://example.com

# Recommended: use --only-main-content for clean output without nav/footer
firecrawl https://example.com --only-main-content
```

#### Output Formats

```bash CLI theme={null}
# Get HTML output
firecrawl https://example.com --html

# Multiple formats (returns JSON)
firecrawl https://example.com --format markdown,links

# Available formats: markdown, html, rawHtml, links, screenshot, json
```

#### Scrape Options

```bash CLI theme={null}
# Extract only main content (removes navs, footers)
firecrawl https://example.com --only-main-content

# Wait for JavaScript rendering
firecrawl https://example.com --wait-for 3000

# Take a screenshot
firecrawl https://example.com --screenshot

# Include/exclude specific HTML tags
firecrawl https://example.com --include-tags article,main
firecrawl https://example.com --exclude-tags nav,footer

# Save output to file
firecrawl https://example.com -o output.md

# Pretty print JSON output
firecrawl https://example.com --format markdown,links --pretty
```

**Available Options:**

| Option                  | Short | Description                                                                                    |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `--url <url>`           | `-u`  | URL to scrape (alternative to positional argument)                                             |
| `--format <formats>`    | `-f`  | Output formats (comma-separated): `markdown`, `html`, `rawHtml`, `links`, `screenshot`, `json` |
| `--html`                | `-H`  | Shortcut for `--format html`                                                                   |
| `--only-main-content`   |       | Extract only main content                                                                      |
| `--wait-for <ms>`       |       | Wait time in milliseconds for JS rendering                                                     |
| `--screenshot`          |       | Take a screenshot                                                                              |
| `--include-tags <tags>` |       | HTML tags to include (comma-separated)                                                         |
| `--exclude-tags <tags>` |       | HTML tags to exclude (comma-separated)                                                         |
| `--output <path>`       | `-o`  | Save output to file                                                                            |
| `--pretty`              |       | Pretty print JSON output                                                                       |

***

### Search

Search the web and optionally scrape the results.

```bash CLI theme={null}
# Search the web
firecrawl search "web scraping tutorials"

# Limit results
firecrawl search "AI news" --limit 10

# Pretty print results
firecrawl search "machine learning" --pretty
```

#### Search Options

```bash CLI theme={null}
# Search specific sources
firecrawl search "AI" --sources web,news,images

# Search with category filters
firecrawl search "react hooks" --categories github
firecrawl search "machine learning" --categories research,pdf

# Time-based filtering
firecrawl search "tech news" --tbs qdr:h   # Last hour
firecrawl search "tech news" --tbs qdr:d   # Last day
firecrawl search "tech news" --tbs qdr:w   # Last week
firecrawl search "tech news" --tbs qdr:m   # Last month
firecrawl search "tech news" --tbs qdr:y   # Last year

# Location-based search
firecrawl search "restaurants" --location "Berlin,Germany" --country DE

# Search and scrape results
firecrawl search "documentation" --scrape --scrape-formats markdown

# Save to file
firecrawl search "firecrawl" --pretty -o results.json
```

**Available Options:**

| Option                       | Description                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `--limit <number>`           | Maximum results (default: 5, max: 100)                                                      |
| `--sources <sources>`        | Sources to search: `web`, `images`, `news` (comma-separated)                                |
| `--categories <categories>`  | Filter by category: `github`, `research`, `pdf` (comma-separated)                           |
| `--tbs <value>`              | Time filter: `qdr:h` (hour), `qdr:d` (day), `qdr:w` (week), `qdr:m` (month), `qdr:y` (year) |
| `--location <location>`      | Geo-targeting (e.g., "Berlin,Germany")                                                      |
| `--country <code>`           | ISO country code (default: US)                                                              |
| `--timeout <ms>`             | Timeout in milliseconds (default: 60000)                                                    |
| `--ignore-invalid-urls`      | Exclude URLs invalid for other Firecrawl endpoints                                          |
| `--scrape`                   | Scrape search results                                                                       |
| `--scrape-formats <formats>` | Formats for scraped content (default: markdown)                                             |
| `--only-main-content`        | Include only main content when scraping (default: true)                                     |
| `--json`                     | Output as JSON                                                                              |
| `--output <path>`            | Save output to file                                                                         |
| `--pretty`                   | Pretty print JSON output                                                                    |

***

### Map

Discover all URLs on a website quickly.

```bash CLI theme={null}
# Discover all URLs on a website
firecrawl map https://example.com

# Output as JSON
firecrawl map https://example.com --json

# Limit number of URLs
firecrawl map https://example.com --limit 500
```

#### Map Options

```bash CLI theme={null}
# Filter URLs by search query
firecrawl map https://example.com --search "blog"

# Include subdomains
firecrawl map https://example.com --include-subdomains

# Control sitemap usage
firecrawl map https://example.com --sitemap include   # Use sitemap
firecrawl map https://example.com --sitemap skip      # Skip sitemap
firecrawl map https://example.com --sitemap only      # Only use sitemap

# Ignore query parameters (dedupe URLs)
firecrawl map https://example.com --ignore-query-parameters

# Save to file
firecrawl map https://example.com -o urls.txt
firecrawl map https://example.com --json --pretty -o urls.json
```

**Available Options:**

| Option                      | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `--url <url>`               | URL to map (alternative to positional argument) |
| `--limit <number>`          | Maximum URLs to discover                        |
| `--search <query>`          | Filter URLs by search query                     |
| `--sitemap <mode>`          | Sitemap handling: `include`, `skip`, `only`     |
| `--include-subdomains`      | Include subdomains                              |
| `--ignore-query-parameters` | Treat URLs with different params as same        |
| `--json`                    | Output as JSON                                  |
| `--output <path>`           | Save output to file                             |
| `--pretty`                  | Pretty print JSON output                        |

***

### Crawl

Crawl an entire website starting from a URL.

```bash CLI theme={null}
# Start a crawl (returns job ID immediately)
firecrawl crawl https://example.com

# Wait for crawl to complete
firecrawl crawl https://example.com --wait

# Wait with progress indicator
firecrawl crawl https://example.com --wait --progress
```

#### Check Crawl Status

```bash CLI theme={null}
# Check crawl status using job ID
firecrawl crawl <job-id>

# Example with a real job ID
firecrawl crawl 550e8400-e29b-41d4-a716-446655440000
```

#### Crawl Options

```bash CLI theme={null}
# Limit crawl depth and pages
firecrawl crawl https://example.com --limit 100 --max-depth 3 --wait

# Include only specific paths
firecrawl crawl https://example.com --include-paths /blog,/docs --wait

# Exclude specific paths
firecrawl crawl https://example.com --exclude-paths /admin,/login --wait

# Include subdomains
firecrawl crawl https://example.com --allow-subdomains --wait

# Crawl entire domain
firecrawl crawl https://example.com --crawl-entire-domain --wait

# Rate limiting
firecrawl crawl https://example.com --delay 1000 --max-concurrency 2 --wait

# Custom polling interval and timeout
firecrawl crawl https://example.com --wait --poll-interval 10 --timeout 300

# Save results to file
firecrawl crawl https://example.com --wait --pretty -o results.json
```

**Available Options:**

| Option                      | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `--url <url>`               | URL to crawl (alternative to positional argument) |
| `--wait`                    | Wait for crawl to complete                        |
| `--progress`                | Show progress indicator while waiting             |
| `--poll-interval <seconds>` | Polling interval (default: 5)                     |
| `--timeout <seconds>`       | Timeout when waiting                              |
| `--status`                  | Check status of existing crawl job                |
| `--limit <number>`          | Maximum pages to crawl                            |
| `--max-depth <number>`      | Maximum crawl depth                               |
| `--include-paths <paths>`   | Paths to include (comma-separated)                |
| `--exclude-paths <paths>`   | Paths to exclude (comma-separated)                |
| `--sitemap <mode>`          | Sitemap handling: `include`, `skip`, `only`       |
| `--allow-subdomains`        | Include subdomains                                |
| `--allow-external-links`    | Follow external links                             |
| `--crawl-entire-domain`     | Crawl entire domain                               |
| `--ignore-query-parameters` | Treat URLs with different params as same          |
| `--delay <ms>`              | Delay between requests                            |
| `--max-concurrency <n>`     | Maximum concurrent requests                       |
| `--output <path>`           | Save output to file                               |
| `--pretty`                  | Pretty print JSON output                          |

***

### Credit Usage

Check your team's credit balance and usage.

```bash CLI theme={null}
# View credit usage
firecrawl credit-usage

# Output as JSON
firecrawl credit-usage --json --pretty
```

***

### Version

Display the CLI version.

```bash CLI theme={null}
firecrawl version
# or
firecrawl --version
```

## Global Options

These options are available for all commands:

| Option            | Short | Description                                            |
| ----------------- | ----- | ------------------------------------------------------ |
| `--status`        |       | Show version, auth, concurrency, and credits           |
| `--api-key <key>` | `-k`  | Override stored API key for this command               |
| `--api-url <url>` |       | Use custom API URL (for self-hosted/local development) |
| `--help`          | `-h`  | Show help for a command                                |
| `--version`       | `-V`  | Show CLI version                                       |

## Output Handling

The CLI outputs to stdout by default, making it easy to pipe or redirect:

```bash CLI theme={null}
# Pipe markdown to another command
firecrawl https://example.com | head -50

# Redirect to a file
firecrawl https://example.com > output.md

# Save JSON with pretty formatting
firecrawl https://example.com --format markdown,links --pretty -o data.json
```

### Format Behavior

* **Single format**: Outputs raw content (markdown text, HTML, etc.)
* **Multiple formats**: Outputs JSON with all requested data

```bash CLI theme={null}
# Raw markdown output
firecrawl https://example.com --format markdown

# JSON output with multiple formats
firecrawl https://example.com --format markdown,links
```

## Examples

### Quick Scrape

```bash CLI theme={null}
# Get markdown content from a URL (use --only-main-content for clean output)
firecrawl https://docs.firecrawl.dev --only-main-content

# Get HTML content
firecrawl https://example.com --html -o page.html
```

### Full Site Crawl

```bash CLI theme={null}
# Crawl a docs site with limits
firecrawl crawl https://docs.example.com --limit 50 --max-depth 2 --wait --progress -o docs.json
```

### Site Discovery

```bash CLI theme={null}
# Find all blog posts
firecrawl map https://example.com --search "blog" -o blog-urls.txt
```

### Research Workflow

```bash CLI theme={null}
# Search and scrape results for research
firecrawl search "machine learning best practices 2024" --scrape --scrape-formats markdown --pretty
```

### Combine with Other Tools

```bash CLI theme={null}
# Extract URLs from search results
jq -r '.data.web[].url' search-results.json

# Get titles from search results
jq -r '.data.web[] | "\(.title): \(.url)"' search-results.json

# Extract links and process with jq
firecrawl https://example.com --format links | jq '.links[].url'

# Count URLs from map
firecrawl map https://example.com | wc -l
```

## Telemetry

The CLI collects anonymous usage data during authentication to help improve the product:

* CLI version, OS, and Node.js version
* Development tool detection (e.g., Cursor, VS Code, Claude Code)

**No command data, URLs, or file contents are collected via the CLI.**

To disable telemetry, set the environment variable:

```bash CLI theme={null}
export FIRECRAWL_NO_TELEMETRY=1
```

## Open Source

The Firecrawl CLI and Skill are open source and available on GitHub: [firecrawl/cli](https://github.com/firecrawl/cli)
