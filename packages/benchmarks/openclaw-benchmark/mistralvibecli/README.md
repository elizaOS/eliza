# Mistral Vibe CLI Environment

This directory provides a reproducible development environment for the Mistral Vibe CLI (`vibe`), including **170+ skills** from multiple skill libraries.

## Prerequisites

- **Nix** (with flakes enabled)
- **direnv** (recommended)

## Quick Start

1.  **Enter the Environment**:
    ```bash
    cd mistralvibecli
    direnv allow  # or: nix develop
    ```

2.  **Run Setup**:
    ```bash
    ./setup.sh
    ```
    This installs `mistral-vibe` via `uv` internally in `.isolated_home`.

3.  **Configure API Key**:
    Add your Mistral API key to `.isolated_home/.vibe/.env`:
    ```bash
    echo "MISTRAL_API_KEY=your_key_here" > .isolated_home/.vibe/.env
    ```

4.  **Start Vibe**:
    ```bash
    vibe
    ```

## Skill Libraries

This environment includes skills from multiple sources:

### Anthropic Skills (16 skills)
Official skills from [anthropics/skills](https://github.com/anthropics/skills):
- **anthropic-docx**: Document creation and editing
- **anthropic-pdf**: PDF processing
- **anthropic-pptx**: PowerPoint generation
- **anthropic-xlsx**: Excel spreadsheet handling
- **anthropic-frontend-design**: Frontend design patterns
- **anthropic-skill-creator**: Guide for creating new skills
- **anthropic-mcp-builder**: MCP server creation
- ...and more

### wshobson Plugins (150+ skills)
Comprehensive skill collection from [wshobson/agents](https://github.com/wshobson/agents):
- **Python Development**: `ws-python-design-patterns`, `ws-async-python-patterns`, `ws-uv-package-manager`
- **Backend/API**: `ws-fastapi-templates`, `ws-api-design-principles`, `ws-microservices-patterns`
- **Frontend**: `ws-react-state-management`, `ws-nextjs-app-router-patterns`, `ws-tailwind-design-system`
- **DevOps/CI/CD**: `ws-gitops-workflow`, `ws-github-actions-templates`, `ws-k8s-manifest-generator`
- **Security**: `ws-sast-configuration`, `ws-threat-mitigation-mapping`, `ws-memory-safety-patterns`
- **LLM/AI**: `ws-prompt-engineering-patterns`, `ws-rag-implementation`, `ws-langchain-architecture`
- **Data Engineering**: `ws-dbt-transformation-patterns`, `ws-airflow-dag-patterns`, `ws-spark-optimization`
- ...and many more

### Custom Skills (2 skills)
- **hello-world**: Simple example skill
- **project-stats**: Project analysis (file counts, lines of code)

## Updating Skills

To update skills from upstream repositories:

```bash
cd references/skills-sources/anthropics-skills && git pull
cd ../wshobson-agents && git pull
cd ../..
./sync_skills.sh
```

## Documentation

- `docs/README.md`: Official Mistral Vibe documentation
- `docs/AGENTS.md`: Agent types and configuration
- `references/mistral-vibe-src/`: Full source code

## API Keys Configuration

### Setting Up API Keys
Copy the example file and add your keys:

```bash
cp .isolated_home/.vibe/.env.example .isolated_home/.vibe/.env
# Edit .env and add your MISTRAL_API_KEY
```

Available keys (see `.env.example` for full list):
- `MISTRAL_API_KEY` (required)
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (other LLMs)
- `GITHUB_TOKEN` (for GitHub MCP server)
- `SERPER_API_KEY`, `TAVILY_API_KEY` (web search)

### MCP Servers (External Tools)
MCP servers extend Vibe with external capabilities. Configure in `.isolated_home/.vibe/config.toml`:

```toml
[[mcp_servers]]
name = "github"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { "GITHUB_PERSONAL_ACCESS_TOKEN" = "${GITHUB_TOKEN}" }
```

See `config.toml` for more MCP server examples (web fetch, filesystem, search).
