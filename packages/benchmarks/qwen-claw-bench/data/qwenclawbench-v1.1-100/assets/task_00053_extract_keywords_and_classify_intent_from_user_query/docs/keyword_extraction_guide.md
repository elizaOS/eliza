# Keyword Extraction Pipeline — Operational Guide

## Overview

This guide documents the intent classification and keyword extraction behavior of the context-awareness pipeline. Use it together with `config/extraction_rules.yaml` and `config/intent_mapping.json` when processing user queries.

---

## Intent Classification

Each query is classified into one intent category. The supported categories are defined in `config/intent_mapping.json`:

| Intent | Description |
|--------|-------------|
| `search_memory` | Queries referencing past conversations or stored memories |
| `search_file` | Queries about finding, referencing, or working with specific files |
| `general` | General information queries, how-to questions, explanation requests |

### Conflict Resolution: Priority Rules

Most queries trigger patterns in only one category. When a query matches trigger patterns from **multiple intent categories simultaneously**, priority resolution applies.

**Priority resolution rule: the intent with the higher `priority` value in `config/extraction_rules.yaml` takes precedence.**

Current priority values:

| Intent | Priority | Notes |
|--------|----------|-------|
| `search_file` | 2 | File-related queries; takes precedence over memory queries |
| `search_memory` | 1 | Memory/conversation recall; lower priority than file queries |
| `general` | 0 | Default fallback when no specific intent triggers |

**Example**: A query containing "视频" (triggers `search_file`) and "继续" or "对话" (triggers `search_memory`) would be classified as **`search_file`** because its priority (2) exceeds `search_memory`'s priority (1).

---

## Keyword Extraction Settings

Keywords are extracted according to the settings in `config/extraction_rules.yaml` (`extraction_settings` block):

- **`max_keywords`**: Upper bound on the number of keywords to return
- **`max_words_per_keyword`**: Maximum Chinese/English words per keyword phrase
- **`preserve_proper_nouns`**: File names, project identifiers, and technical terms are kept verbatim regardless of stop word rules
- **`min_keyword_length`**: Minimum character length; single-character tokens below this threshold are discarded
- **`deduplication`**: Exact-match duplicates are removed before the final list is assembled

---

## Stop Word Removal

The `stop_words` list in `config/extraction_rules.yaml` defines function words (Chinese particles, pronouns, modal words) that carry no retrieval value and must be excluded from the output keywords array. Proper nouns and technical terms are exempt from this removal even if they contain stop word characters as substrings.

---

## Memory and File Matching

After keyword extraction, the pipeline cross-references two registries:

- **`data/memory_index.json`**: Match against each entry's `keywords` array using exact or partial overlap
- **`data/file_registry.json`**: Match against `filename`, `tags`, and `description` fields

Return all entry IDs (for `matched_memory_ids`) and filenames (for `matched_files`) where at least one extracted keyword matches.
