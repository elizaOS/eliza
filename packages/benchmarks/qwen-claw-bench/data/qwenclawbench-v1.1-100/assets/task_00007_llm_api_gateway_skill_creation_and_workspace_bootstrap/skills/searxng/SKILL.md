# SearXNG Search Skill

Privacy-respecting metasearch using your local SearXNG instance. Search the web, images, news, and more without external API dependencies.

## Usage

Use this skill when you need to search the web. The local SearXNG instance provides privacy-respecting results aggregated from multiple search engines.

## Configuration

Set `SEARXNG_URL` in your environment (default: `http://localhost:8888`).

## Endpoints

- **Web search**: `GET {SEARXNG_URL}/search?q={query}&format=json`
- **Images**: `GET {SEARXNG_URL}/search?q={query}&categories=images&format=json`
- **News**: `GET {SEARXNG_URL}/search?q={query}&categories=news&format=json`

## Examples

```bash
curl "http://localhost:8888/search?q=weather+today&format=json"
```
