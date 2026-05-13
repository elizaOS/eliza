# Embedded OS Assistant — Team Meeting Notes Q1 2024

---

## Meeting 1: Project Kickoff

**Date:** January 12, 2024  
**Attendees:** James Chen (Lead Engineer), Maria Gonzalez (ML Engineer), David Park (PM)  
**Location:** Conference Room B / Zoom

### Agenda
1. Project scope definition
2. Team allocation
3. Initial requirements gathering

### Discussion

**David** opened the meeting by outlining the project goal: build an AI-powered assistant specialized for embedded operating system development. The assistant should help engineers with RTOS selection, code generation, debugging workflows, and architecture decisions.

**Key Requirements Identified:**

- **Offline mode is mandatory.** Many embedded development environments are air-gapped or have restricted internet access. The assistant must be able to function with a local knowledge base and optionally a local LLM.
- **Knowledge base update cadence:** Monthly updates are sufficient given the pace of embedded OS releases. Automated ingestion pipeline preferred.
- **Priority RTOS platforms:** FreeRTOS, Zephyr, and RT-Thread are the top three based on market survey and customer feedback. Other RTOS platforms (NuttX, ChibiOS, ThreadX) are secondary.
- **Language support:** Must handle code generation in **C** (primary) and **Rust** (growing demand in embedded). C++ is nice-to-have but not priority.
- **Budget:** $500/month for API costs (OpenAI or equivalent). This is a hard constraint from finance.
- **Team size:** 2 engineers (James and Maria) working full-time on this for Q1-Q2 2024.

### Action Items
| # | Item | Owner | Due |
|---|------|-------|-----|
| 1 | Survey existing embedded knowledge sources | Maria | Jan 19 |
| 2 | Set up vector database prototype | James | Jan 26 |
| 3 | Draft initial prompt templates | Maria | Jan 26 |
| 4 | Create project timeline | David | Jan 19 |

---

## Meeting 2: Architecture Review

**Date:** February 9, 2024  
**Attendees:** James Chen, Maria Gonzalez, David Park  
**Location:** Conference Room B / Zoom

### Agenda
1. Knowledge base architecture
2. Tool integration requirements
3. Prototype demo

### Discussion

**James** presented the prototype architecture:

1. **Knowledge Base Layer:** ChromaDB as vector store, `text-embedding-3-small` for embeddings. Chunk size of 512 tokens with 64-token overlap was found optimal after testing (tested 256, 512, 1024 — 512 gave best retrieval accuracy on our embedded Q&A test set).
2. **Retrieval Layer:** Hybrid search (semantic + keyword) with top_k=5 and similarity threshold of 0.75. Reranking with a cross-encoder improved answer quality by ~15%.
3. **Tool Integration:** GDB and OpenOCD integration is **critical** — this was the #1 feature request from the beta user survey (23 out of 30 respondents).

**Maria** demonstrated the initial prompt templates:
- RTOS task creation template works well for FreeRTOS
- Driver debugging template needs more context about hardware registers
- Memory optimization template is promising but needs real-world test cases

**Key Decisions:**

- **Debugging workflow:** GDB remote debugging via OpenOCD is the primary workflow. Must support both ARM (via SWD/JTAG) and RISC-V targets.
- **Build system support:** Buildroot and Yocto configuration assistance should be included. Buildroot is easier to support initially.
- **Context window:** Moving to GPT-4 Turbo with 128K context window allows us to include much more reference material per query.
- **Rejected:** Using keyword search (BM25 only) — vector search with reranking significantly outperforms it for technical queries.

### Action Items
| # | Item | Owner | Due |
|---|------|-------|-----|
| 1 | Finalize vector store configuration | James | Feb 16 |
| 2 | Build GDB integration prototype | James | Feb 23 |
| 3 | Expand prompt templates to 10 | Maria | Feb 23 |
| 4 | Run knowledge ingestion on full doc set | Maria | Feb 16 |

---

## Meeting 3: Mid-Quarter Review

**Date:** March 8, 2024  
**Attendees:** James Chen, Maria Gonzalez, David Park, Sarah Kim (VP Engineering, guest)  
**Location:** Conference Room A / Zoom

### Agenda
1. Progress review
2. Knowledge ingestion results
3. Demo for VP Engineering
4. Q2 planning

### Discussion

**Maria** presented the knowledge ingestion results:
- FreeRTOS reference manual: 342 chunks, fully ingested ✅
- Zephyr documentation: 1,205 chunks, fully ingested ✅
- RT-Thread programming guide: **Only 89 out of 450 pages processed** — the majority of the documentation is in Chinese and our text splitter doesn't handle GB2312 encoding. This is a known gap.
- ARM Architecture Reference Manual: 2,100 chunks ✅
- RISC-V ISA specification: 890 chunks ✅
- Various blog posts and tutorials: ~230 chunks total ✅

**Total knowledge base:** ~4,853 chunks in vector store.

**James** demoed the GDB integration:
- Can parse GDB output and provide natural language explanations of crash dumps
- OpenOCD bridge works for STM32 and ESP32 targets
- Still needs work on RISC-V target support via OpenOCD

**Sarah** (VP) feedback:
- Impressed with the debugging integration
- Asked about competitive differentiation — general-purpose coding assistants don't understand embedded constraints (memory, real-time, power)
- Approved continuation into Q2 with same budget ($500/month)
- Suggested exploring Rust embedded support as a differentiator

**Key Decisions:**

- **RT-Thread gap:** Will look for English-language RT-Thread resources or community translations. Not blocking launch.
- **Skill matrix:** Created a skill coverage matrix (see `data/skill_matrix.csv`) to track what the assistant can and cannot do.
- **Testing:** Need a structured evaluation framework — plan to create 100 test queries across all domains.
- **Q2 priorities:** (1) Complete tool integrations, (2) Expand RISC-V support, (3) Add Rust embedded code generation, (4) Offline mode implementation.

### Action Items
| # | Item | Owner | Due |
|---|------|-------|-----|
| 1 | Fix RT-Thread encoding issue | Maria | Mar 22 |
| 2 | Complete RISC-V OpenOCD support | James | Mar 29 |
| 3 | Create evaluation test set (100 queries) | Maria | Mar 29 |
| 4 | Draft Q2 implementation timeline | David | Mar 15 |
| 5 | Investigate local LLM options for offline mode | James | Mar 29 |

---

*Notes compiled by David Park, Project Manager*
