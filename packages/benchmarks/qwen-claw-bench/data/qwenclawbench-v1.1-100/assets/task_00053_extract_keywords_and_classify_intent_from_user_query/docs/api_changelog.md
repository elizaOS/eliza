# SearchCore API Changelog

All notable changes to the SearchCore API service are documented in this file.

---

## v3.2.0 — 2026-03-10

### Added
- Real-time index refresh for newly ingested documents
- Keyword extraction improvements with support for multi-language tokenization
- Batch query endpoint for processing up to 50 queries per request

### Changed
- Upgraded Elasticsearch backend from 8.11 to 8.14
- Improved relevance scoring algorithm with BM25F tuning

### Fixed
- Fixed edge case where duplicate results appeared in paginated responses
- Resolved timeout issues on large corpus full-text searches

---

## v3.1.2 — 2026-02-15

### Added
- Support for fuzzy matching with configurable edit distance
- Keyword extraction improvements for CJK (Chinese, Japanese, Korean) text processing

### Changed
- Reduced average query latency by 18% through query plan optimization
- Updated stop word dictionaries for 12 supported languages

### Fixed
- Fixed incorrect document count in aggregation responses

---

## v3.1.0 — 2026-01-20

### Added
- Faceted search support with dynamic field detection
- Auto-suggestion endpoint with prefix and infix matching
- New indexing pipeline for structured metadata extraction

### Changed
- Migrated from synchronous to asynchronous indexing workers
- Keyword extraction improvements: better handling of compound terms and technical jargon

### Fixed
- Fixed memory leak in long-running indexing jobs
- Resolved race condition in concurrent index updates

---

## v3.0.1 — 2025-12-05

### Added
- Health check endpoint with detailed component status

### Changed
- Improved error messages for malformed query syntax
- Optimized inverted index storage format reducing disk usage by 22%

### Fixed
- Fixed incorrect highlighting offsets for multi-byte character queries
- Resolved issue where deleted documents remained in search results

---

## v3.0.0 — 2025-11-01

### Added
- Complete API redesign with RESTful resource-oriented endpoints
- Support for vector similarity search using HNSW algorithm
- Pluggable analyzer framework for custom tokenization pipelines
- Keyword extraction improvements with TF-IDF based term weighting
- Role-based access control for index and query operations

### Changed
- Breaking: Query DSL syntax updated — see migration guide
- Breaking: Authentication switched from API keys to OAuth 2.0
- Minimum supported client SDK version bumped to 4.0

### Removed
- Deprecated v2.x XML response format
- Legacy synonym expansion engine (replaced by neural synonym detection)
