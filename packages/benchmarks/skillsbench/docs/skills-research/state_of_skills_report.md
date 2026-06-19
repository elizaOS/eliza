# State of Skills/MCP Ecosystem Report
## SkillsBench Research - January 2026

### Executive Summary

The MCP (Model Context Protocol) and Claude Skills ecosystem has grown significantly, with multiple
directories and marketplaces emerging to organize and distribute these capabilities.

### Directory Landscape

| Directory | URL | Estimated Count | Focus |
|-----------|-----|-----------------|-------|
| PulseMCP | https://www.pulsemcp.com/servers | 7584 | Daily-updated directory of MCP servers |
| Smithery.ai | https://smithery.ai/servers | 48 | Curated MCP servers with usage metrics |
| SkillsMP.com | https://skillsmp.com | 47170 | Skills marketplace aggregating GitHub repositories |
| MCPServers.org | https://mcpservers.org | 500+ | Curated MCP servers and Claude skills collection |
| awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | 1200+ | Community-maintained awesome list |
| awesome-claude-skills | https://github.com/travisvn/awesome-claude-skills | 50+ | Curated Claude skills list |
| anthropics/skills | https://github.com/anthropics/skills | 14 | Official Anthropic skills repository |
| claude-scientific-skills | https://github.com/K-Dense-AI/claude-scientific-skills | 139 | Scientific domain skills collection |
| netresearch marketplace | https://github.com/netresearch/claude-code-marketplace | 20 | Enterprise-focused skills |
| claudecodeplugin.com | https://www.claudecodeplugin.com | 50+ | Plugin and skills directory |

### SkillsMP.com Category Distribution (47,170 total)

| Category | Count | Percentage |
|----------|-------|------------|
| Tools | 15,346 | 32.5% |
| Development | 14,436 | 30.6% |
| Data & AI | 9,234 | 19.6% |
| Business | 7,949 | 16.9% |
| DevOps | 7,477 | 15.9% |
| Testing & Security | 5,518 | 11.7% |
| Documentation | 4,032 | 8.5% |
| Content & Media | 3,909 | 8.3% |
| Lifestyle | 2,151 | 4.6% |
| Research | 1,914 | 4.1% |
| Databases | 1,067 | 2.3% |
| Blockchain | 350 | 0.7% |

### Analyzed Skills/Servers: 257

| Source | Count |
|--------|-------|
| claude-scientific-skills | 100 |
| PulseMCP | 40 |
| mcpservers.org | 38 |
| awesome-mcp-servers | 36 |
| netresearch | 15 |
| anthropics/skills | 14 |
| awesome-claude-skills | 8 |
| Smithery | 6 |

### Skills by Domain Category

| Category | Count | Top Examples |
|----------|-------|-------------|
| Other | 47 | Filesystem, Time, Zapier |
| Scientific | 31 | BioPython, pysam, scikit-bio |
| Database | 28 | Context7, pg-aiguide, Toolbox for Databases |
| AI & ML | 28 | askbudi/roundtable, glenngillen/mcpmcp-server, metatool-ai/metatool-app |
| Search & Web | 26 | Fetch, FireCrawl, Smart Coding |
| Design & Creative | 19 | mikechao/metmuseum-mcp, Matplotlib, Seaborn |
| Version Control & CI/CD | 16 | GitHub, Agent Mail, Git |
| Browser Automation | 12 | Playwright Browser Automation, Playwriter, Chrome DevTools |
| Cloud & Infrastructure | 12 | AWS Documentation, Atlassian Cloud, AWS CDK |
| Communication & Productivity | 11 | Slack, Gmail, slack-gif-creator |
| Document Processing | 11 | docx, pdf, pptx |
| Development Tools | 9 | Knowledge Graph Memory, mcp-builder, skill-creator |
| Security | 4 | BurtTheCoder/mcp-virustotal, semgrep/mcp, Enterprise Readiness |
| Finance & Blockchain | 3 | Yahoo Finance, getAlby/mcp, stripe-best-practices |

### Semantic Duplicates Found: 3 clusters

Top duplicate clusters (similarity >= 0.85):

- **Playwright Browser Automation** appears in: PulseMCP
- **Ensembl** appears in: claude-scientific-skills
- **Literature Review** appears in: claude-scientific-skills

### Top MCP Servers by Weekly Visitors (PulseMCP)

| Rank | Server | Provider | Weekly Visitors |
|------|--------|----------|----------------|
| 1 | Playwright Browser Automation | Microsoft | 719k |
| 2 | Context7 | Upstash | 432k |
| 3 | pg-aiguide | Timescale | 158k |
| 4 | Playwriter | Tommaso De Rossi | 128k |
| 5 | AWS Documentation | AWS | 119k |
| 6 | Fetch | Anthropic | 114k |
| 7 | GitHub | GitHub | 103k |
| 8 | Filesystem | Anthropic | 76.8k |
| 9 | Time | Anthropic | 75.6k |
| 10 | Zapier | Zapier | 63.7k |
| 11 | Sequential Thinking | Anthropic | 56.3k |
| 12 | Yahoo Finance | narumi | 53.9k |
| 13 | Chrome DevTools | Google | 52.4k |
| 14 | Blender | Siddharth Ahuja | 42.5k |
| 15 | Atlassian Cloud | sooperset | 41.5k |

### Key Insights

1. **Fragmented Ecosystem**: Skills and MCP servers are distributed across 10+ directories with significant overlap
2. **Development Tools Dominate**: Browser automation, Git, and testing tools are most popular
3. **Official vs Community**: Anthropic maintains ~14 official skills, while community has created thousands
4. **Scientific Niche**: claude-scientific-skills provides 139+ specialized research capabilities
5. **Enterprise Integration**: Strong presence of Atlassian, Notion, Slack, and enterprise tool integrations
6. **Rapid Growth**: PulseMCP tracks 7,584 servers; SkillsMP indexes 47,170 skill repositories

### Recommendations for SkillsBench Tasks

Based on analysis, these skill categories would make excellent benchmark tasks:

1. **Browser Automation** - High usage, measurable outcomes (Playwright, Puppeteer)
2. **Document Processing** - Clear success criteria (PDF, XLSX manipulation)
3. **Database Operations** - Verifiable queries and data transformations
4. **Scientific Computing** - Domain-specific accuracy requirements
5. **Code Analysis** - Security scanning, linting, testing
6. **API Integration** - Third-party service interaction patterns
