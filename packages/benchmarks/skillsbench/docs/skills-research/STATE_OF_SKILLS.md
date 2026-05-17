# State of AI Coding Agent Skills Ecosystem
## SkillsBench Research - January 2026

---

## 1. Executive Summary

We analyzed skills across **5,985 GitHub repos** (47,153+ skills total) supporting multiple AI coding agents (Claude Code, Codex, OpenCode, Factory, Goose, Amp).

| Metric | Count |
|--------|-------|
| Total skills collected | 47,153+ |
| **Total GitHub repos** | **5,985** |
| Repos with 1K+ stars | 89 |
| Repos with 10K+ stars | 16 |
| Official skills (Anthropic + OpenAI) | 26 |
| Semantically unique (90% threshold) | **40,721** |
| Duplicate rate | 13.6% |

---

## 2. What Are Skills?

**Skills** are SKILL.md markdown files that teach AI coding agents *how* to use tools effectively.

| Aspect | Skills | MCP Servers |
|--------|--------|-------------|
| **Purpose** | Teach agents patterns & workflows | Provide tool access |
| **Format** | SKILL.md markdown | JSON-RPC protocol |
| **Location** | Agent-specific directories | Config files |

### Multi-Agent Skill Support

Skills are used by multiple AI coding agents, each with their own directory:

| Agent | Path | Repos |
|-------|------|-------|
| **Claude Code** | `.claude/skills/` | 5,897 |
| **Codex** | `.codex/skills/` | 98 |
| **OpenCode** | `.opencode/skill/` | 65 |
| **Factory** | `.factory/skills/` | 34 |
| **Portable (Goose/Amp)** | `.agents/skills/` | 27 |
| **Goose** | `.goose/skills/` | 1 |

**Total unique repos: 5,985** (some repos support multiple agents)

### Top Repos with Skills (Any Agent)

| Repo | Stars | Skills | Agent |
|------|-------|--------|-------|
| langgenius/dify | 125K | 2 | claude |
| pytorch/pytorch | 96K | 4 | claude |
| openai/codex | 55K | 2 | claude |
| anthropics/claude-code | 52K | 10 | claude |
| anomalyco/opencode | 52K | 1 | opencode |
| tldraw/tldraw | 44K | 1 | claude |
| anthropics/skills | 34K | 17 | claude |
| yamadashy/repomix | 21K | 4 | claude |
| langfuse/langfuse | 20K | 2 | claude |
| obra/superpowers | 14K | 14 | claude |

Full data: [all_repos_with_skills.json](all_repos_with_skills.json)

---

## 3. Data Sources

| Source | Skills | Type |
|--------|--------|------|
| SkillsMP.com (full API, 472 pages) | 46,942 | Aggregator |
| K-Dense-AI/claude-scientific-skills | 142 | Curated |
| netresearch/claude-code-marketplace | 22 | Curated |
| anthropics/skills | 17 | Official |
| obra/superpowers | 14 | Curated |
| awesome-claude-skills (community) | 6 | Curated |
| **Total unique** | **47,143** | |

### Additional Skills Registries

| Registry | Skills | GitHub Repos | Notes |
|----------|--------|--------------|-------|
| **SkillsMP.com** | 47,143 | 6,324 | Full API access, used for analysis |
| **Smithery.ai/skills** | ~28,241 | - | Client-side rendered, no public API |

**Registry Overlap Analysis**: We verified 1,100 randomly sampled SkillsMP skills against Smithery - **100% were found on both registries**. Both index SKILL.md files from GitHub, so Smithery's ~28K skills are a subset of SkillsMP's 47K. We used SkillsMP for analysis due to full API access.

### GitHub Repository Coverage

We conducted a **comprehensive GitHub code search** for SKILL.md files, combining:
1. SkillsMP aggregated data (5,586 repos)
2. Direct GitHub code search (301 new repos not in SkillsMP)

| Category | Repos | Description |
|----------|-------|-------------|
| **Total unique repos** | **5,887** | Combined SkillsMP + GitHub direct search |
| Non-skill-focused (real software) | 3,661 | Real software projects with skills |
| Skill-focused projects | 2,226 | Agent/skill-related projects |
| From SkillsMP | 5,586 | Aggregator index |
| From GitHub direct (new) | 301 | Not in SkillsMP |
| Overlap | 248 | In both sources |

### Top Non-Skill-Focused Repos (Real Software Projects Using Skills)

| Repo | Stars | Skills | Description |
|------|-------|--------|-------------|
| **langgenius/dify** | **124,943** | 2 | Agentic workflow platform |
| pytorch/pytorch | 96,381 | 4 | PyTorch ML framework |
| openai/codex | 55,349 | 2 | OpenAI Codex CLI |
| **tldraw/tldraw** | **44,467** | 1 | Infinite canvas SDK |
| **payloadcms/payload** | **39,727** | 1 | Headless CMS |
| yamadashy/repomix | 21,017 | 4 | Repo packer for LLMs |
| langfuse/langfuse | 20,226 | 2 | LLM observability |
| longbridge/gpui-component | 9,604 | 3 | GPUI components |
| steveyegge/beads | 8,611 | 2 | Programming language |
| redpanda-data/connect | 8,543 | 3 | Streaming data platform |
| bytedance/flowgram.ai | 7,513 | 1 | ByteDance workflow tool |
| **NangoHQ/nango** | **6,287** | 1 | Integration API |
| **zenml-io/zenml** | **5,131** | 1 | MLOps platform |
| clidey/whodb | 4,434 | 3 | Database tool |

*Bold = newly discovered via GitHub direct search*

### Top Skill-Focused Repos (Official + Community)

| Repo | Stars | Skills | Description |
|------|-------|--------|-------------|
| anthropics/claude-code | 52,141 | 10 | Claude Code official |
| anthropics/skills | 34,430 | 17 | Official Anthropic skills |
| obra/superpowers | 14,167 | 14 | Popular skills collection |
| langchain-ai/deepagents | 7,849 | 4 | LangChain agents |
| K-Dense-AI/claude-scientific-skills | 4,663 | 142 | Scientific skills (curated) |
| gptme/gptme | 4,136 | 2 | GPT terminal agent |
| openai/skills | 1,249 | 3 | OpenAI official skills |
| huggingface/skills | 792 | 5 | HuggingFace skills |

Full data: [repos_comprehensive.json](repos_comprehensive.json)

### Curated vs Aggregated

| Type | Count | Description |
|------|-------|-------------|
| **Curated sources** | 201 | Hand-picked, verified repos |
| **SkillsMP aggregated** | 46,942 | Auto-scraped GitHub SKILL.md |

Note: SkillsMP automatically indexes any GitHub repo containing SKILL.md files.

### Claude Code Adoption in Major Open Source Projects

We analyzed 88 major open source projects for Claude Code adoption (CLAUDE.md files and .claude/ directories):

| Metric | Count | % |
|--------|-------|---|
| Major repos checked | 88 | - |
| With CLAUDE.md | 14 | 15.9% |
| With .claude/ directory | 7 | 8.0% |
| With SKILL.md files | 2 | 2.3% |

**Top Major Repos with Claude Code Adoption:**

| Repo | Stars | CLAUDE.md | .claude/ | Skills |
|------|-------|-----------|----------|--------|
| vercel/next.js | 136,985 | ✓ | ✓ | - |
| pytorch/pytorch | 96,381 | ✓ | ✓ | 4 |
| oven-sh/bun | 86,015 | ✓ | ✓ | 5 |
| ggerganov/llama.cpp | 92,533 | ✓ | - | - |
| prisma/prisma | 44,992 | ✓ | - | - |
| jestjs/jest | 45,248 | ✓ | - | - |
| pingcap/tidb | 39,562 | ✓ | - | - |
| cockroachdb/cockroach | 31,701 | ✓ | ✓ | - |
| biomejs/biome | 23,008 | ✓ | ✓ | - |
| chakra-ui/chakra-ui | 40,119 | ✓ | ✓ | - |
| mongodb/mongo | 27,963 | ✓ | - | - |
| denoland/deno | 105,746 | ✓ | - | - |
| langchain-ai/langchain | 123,577 | ✓ | - | - |
| shadcn-ui/ui | 104,203 | - | ✓ | - |

**Key Insight**: Major projects like Next.js, PyTorch, and Bun have full Claude Code integration with both CLAUDE.md project instructions and .claude/ directories. However, only 2 of 88 major projects (2.3%) have custom skills, suggesting skills are primarily created by dedicated skill repositories rather than integrated into mainstream projects.

Full data: [major_repos_claude_adoption.json](major_repos_claude_adoption.json)

---

## 4. Deduplication Analysis

### Exact Name Duplicates

| Metric | Count |
|--------|-------|
| Unique names | 32,222 |
| Names with duplicates | 5,615 |
| Total duplicate entries | 14,905 |

### Top Duplicated Skill Names

| Skill Name | Count |
|------------|-------|
| skill-creator | 223 |
| code-review | 157 |
| frontend-design | 151 |
| brainstorming | 92 |
| git-workflow | 86 |
| testing | 78 |
| code-reviewer | 74 |
| systematic-debugging | 65 |
| test-driven-development | 59 |
| writing-plans | 53 |

### Semantic Duplicates (Full Embedding Analysis)

Using OpenAI `text-embedding-3-large` (512 dims) on **ALL 47,153 skills**:

| Threshold | Unique | Duplicates | Dup Rate | Clusters |
|-----------|--------|------------|----------|----------|
| 95% | 42,071 | 5,082 | 10.8% | 3,197 |
| **90%** | **40,721** | **6,432** | **13.6%** | - |
| 85% | 38,495 | 8,658 | 18.4% | - |
| 80% | 34,758 | 12,395 | 26.3% | - |

**Semantically unique skills: ~40,721 (at 90% threshold)**

### Top Duplicate Clusters (95% threshold)
| Skill | Copies | Most Duplicated |
|-------|--------|-----------------|
| frontend-design | 50 | Anthropic official + many forks |
| skill-creator | 47 | Meta-skill copied widely |
| brainstorming | 38 | obra/superpowers fork |

---

## 5. Skills by Category

| Category | Count | % |
|----------|-------|---|
| JavaScript/TypeScript | 23,271 | 49.4% |
| DevOps/Infrastructure | 5,497 | 11.7% |
| Other | 3,951 | 8.4% |
| Python | 2,591 | 5.5% |
| AI/ML | 2,284 | 4.8% |
| Frontend/UI | 1,476 | 3.1% |
| Testing | 1,444 | 3.1% |
| Git/Version Control | 1,216 | 2.6% |
| API | 1,020 | 2.2% |
| Database | 976 | 2.1% |
| Code Quality | 872 | 1.8% |
| Documentation | 647 | 1.4% |
| Security | 589 | 1.2% |
| CLI/Shell | 432 | 0.9% |
| Cloud | 398 | 0.8% |
| Java/Kotlin | 321 | 0.7% |
| Go | 287 | 0.6% |
| C/C++ | 198 | 0.4% |
| Rust | 156 | 0.3% |
| Ruby | 89 | 0.2% |

---

## 6. Key Insights

### 1. JavaScript/TypeScript Dominates
- 49% of all skills target JS/TS ecosystem
- Reflects Claude Code's primary use case

### 2. High Duplication Rate
- 5,615 skill names appear multiple times
- "skill-creator" alone has 223 copies
- Many are forks/copies of popular skills

### 3. DevOps is Second Largest
- 11.7% of skills are DevOps/Infrastructure
- Docker, Kubernetes, Terraform patterns

### 4. AI/ML Growing Fast
- 2,284 skills (4.8%) target AI/ML
- LLM integration, model training patterns

### 5. Testing Is Underrepresented
- Only 3.1% despite importance
- Opportunity for benchmark tasks

---

## 7. Official vs Community Skills

| Source | Count | Notes |
|--------|-------|-------|
| anthropics/skills | 17 | Official reference |
| Curated community | 184 | Quality repos |
| SkillsMP aggregated | 46,942 | Auto-scraped |

**Ratio: 1 official : 2,773 community skills**

### Official Anthropic Skills (17)

| Skill | Category |
|-------|----------|
| docx | Document |
| pdf | Document |
| pptx | Document |
| xlsx | Document |
| algorithmic-art | Creative |
| canvas-design | Creative |
| slack-gif-creator | Creative |
| theme-factory | Creative |
| frontend-design | Development |
| web-artifacts-builder | Development |
| mcp-builder | Development |
| webapp-testing | Development |
| brand-guidelines | Communication |
| internal-comms | Communication |
| doc-coauthoring | Communication |
| skill-creator | Meta |
| + 1 more | Various |

### Curated Scientific Skills (142)

From K-Dense-AI/claude-scientific-skills:
- Bioinformatics: biopython, scanpy, pysam, anndata
- Cheminformatics: rdkit, deepchem, diffdock
- ML/AI: pytorch-lightning, transformers, shap
- Databases: uniprot, pubchem, alphafold-database
- Visualization: matplotlib, plotly, seaborn

### Curated Development Skills

From obra/superpowers (14):
- brainstorming, writing-plans, executing-plans
- test-driven-development, systematic-debugging
- code-review, git-worktrees

From netresearch (22):
- typo3-*, php-modernization, security-audit
- git-workflow, jira-integration

---

## 8. Recommendations for SkillsBench

### High-Value Task Categories

Based on skill prevalence and deduplication analysis:

| Category | Skills Count | Task Potential |
|----------|-------------|----------------|
| JS/TS Development | 23,271 | High - many patterns |
| DevOps/Docker | 5,497 | High - measurable |
| Python | 2,591 | High - common |
| Testing | 1,444 | Medium - underserved |
| Database | 976 | High - verifiable |
| Security | 589 | High - critical |

### Specific Task Ideas

1. **code-review** (157 skills) → Automated PR review task
2. **testing/tdd** (78+59 skills) → Test generation task
3. **git-workflow** (86 skills) → Branch management task
4. **systematic-debugging** (65 skills) → Bug diagnosis task
5. **frontend-design** (151 skills) → UI implementation task

---

## 9. Visualizations

Generated visualizations in `docs/skills-research/`:

| File | Description |
|------|-------------|
| `full_category_distribution.png` | Skills by category (47K) |
| `top_skill_names.png` | Most common skill names |
| `duplicate_analysis.png` | Deduplication statistics |
| `tsne_clusters.png` | Embedding visualization |

---

## 10. Data Files

| File | Size | Description |
|------|------|-------------|
| `all_skills_combined.json` | 22MB | Full 47,143 skills (all sources) |
| `curated_skills.json` | 61KB | 201 curated skills only |
| `all_skills_comprehensive.json` | 22MB | SkillsMP data |
| `repos_comprehensive.json` | 2MB | **5,887 repos (merged SkillsMP + GitHub direct)** |
| `github_skills_direct.json` | 200KB | 549 repos from direct GitHub search |
| `full_dedup_results.json` | 50KB | Full 47K embedding dedup results |
| `full_analysis.json` | 8KB | Category/duplicate analysis |
| `detailed_duplicates.json` | 20KB | Duplicate clusters |
| `skillsmp_smithery_verification.json` | 1KB | 1,100 skill overlap verification |
| `major_repos_claude_adoption.json` | 50KB | 88 major repos Claude Code adoption |
| `all_agent_skills.json` | 100KB | 551 repos with agent-specific directories |
| `all_repos_with_skills.json` | 3MB | **5,985 repos unified (all agents)** |

---

## 11. Methodology

- **Data sources**:
  - SkillsMP.com API (472 pages, full pagination) - 5,586 repos
  - GitHub direct code search (`path:.claude/skills/`, `filename:skill.md triggers`) - 301 additional repos
  - Curated repos via `gh` CLI (anthropics, K-Dense-AI, obra, netresearch)
  - awesome-claude-skills list
- **Comprehensive search**: Combined aggregator (SkillsMP) with direct GitHub search to ensure no major repos missed
- **Embedding model**: OpenAI text-embedding-3-large (512 dims)
- **Deduplication**: Full 47,153 skills (not sampled) using sklearn NearestNeighbors
- **Dedup thresholds**: 95%, 90%, 85%, 80% cosine similarity
- **Repo categorization**: Keyword-based classification into skill-focused vs non-skill-focused
- **Date**: January 2026

---

## 12. Conclusion

The Claude Skills ecosystem has **~40,721 semantically unique skills** (at 90% similarity threshold) across **5,887 GitHub repos**, heavily weighted toward JavaScript/TypeScript (49%) and DevOps (12%).

Key findings for SkillsBench:
1. **5,887 repos** have SKILL.md files (comprehensive GitHub + SkillsMP search)
2. **3,661 non-skill-focused** repos (real software projects like dify, pytorch, tldraw)
3. **langgenius/dify** (125K stars) and **tldraw** (44K stars) are top adopters
4. **JavaScript/TypeScript** dominates → focus benchmark tasks here
5. **Security** and **Testing** are underrepresented → opportunity
6. Community has created 1,813x more skills than official (26 Anthropic + OpenAI)
7. ~13.6% semantic duplication rate at 90% threshold

---

## 13. Research Questions

See [RESEARCH_QUESTIONS.md](RESEARCH_QUESTIONS.md) for detailed analysis of:

| Question | Focus | Status |
|----------|-------|--------|
| **RQ1**: Do skills help agents perform better? | Skill effectiveness | Needs benchmark data |
| **RQ2**: Can agents compose multiple skills? | Skill composition | Design target set |
| **RQ3**: What is the state of the skills ecosystem? | Ecosystem analysis | **Complete** |

**RQ3 Findings** (this report):
- 47,153 skills collected from 7 sources (incl. anthropics/skills + openai/skills)
- **40,721 semantically unique** (90% threshold) - FULL dedup, not sampled
- 13.6% duplication rate (6,432 duplicates across 3,197 clusters)
- Top duplicate clusters: frontend-design (50), skill-creator (47), brainstorming (38)
- JavaScript/TypeScript dominates (49%), Testing underrepresented (3.1%)

**Key Gap**: No existing benchmark measures skill effectiveness. SkillsBench fills this gap.

---

*Research for SkillsBench paper - January 2026*
