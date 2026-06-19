# Tantivy Full-Text Search — Quickstart Guide

## Overview

[Tantivy](https://github.com/quickwit-oss/tantivy) is a full-text search engine library written in Rust, inspired by Apache Lucene. It provides fast indexing and search with a small memory footprint.

## Installation

Add tantivy to your `Cargo.toml`:

```toml
[dependencies]
tantivy = "0.21"
```

For Python bindings, install via pip:

```bash
pip install tantivy
```

## Creating a Schema

Every tantivy index starts with a schema definition:

```rust
use tantivy::schema::*;

let mut schema_builder = Schema::builder();

// Add fields
schema_builder.add_text_field("title", TEXT | STORED);
schema_builder.add_text_field("body", TEXT);
schema_builder.add_date_field("timestamp", INDEXED | STORED);
schema_builder.add_u64_field("session_id", INDEXED | STORED);
schema_builder.add_facet_field("tags", FacetOptions::default());

let schema = schema_builder.build();
```

### Field Types
- `TEXT`: tokenized and indexed for full-text search
- `STRING`: indexed as a single token (for exact matching)
- `STORED`: the original value is stored and can be retrieved
- `INDEXED`: the field is searchable
- `FAST`: enables fast field access (like doc values in Lucene)

## Creating an Index

```rust
use tantivy::Index;
use std::path::Path;

// Create index on disk
let index_path = Path::new("/path/to/index");
let index = Index::create_in_dir(&index_path, schema.clone())?;

// Or create in RAM (for testing)
let index = Index::create_in_ram(schema.clone());
```

## Adding Documents

```rust
let mut index_writer = index.writer(50_000_000)?; // 50MB heap

let title = schema.get_field("title").unwrap();
let body = schema.get_field("body").unwrap();
let timestamp = schema.get_field("timestamp").unwrap();

// Add a document
let mut doc = Document::default();
doc.add_text(title, "Meeting notes: Q4 planning");
doc.add_text(body, "Discussed roadmap priorities for Q4. Key decisions: ...");
doc.add_date(timestamp, DateTime::from_utc(2024, 1, 15, 10, 30, 0));

index_writer.add_document(doc)?;

// Commit changes
index_writer.commit()?;
```

### Batch Indexing

For bulk imports, add multiple documents before committing:

```rust
for entry in memory_entries {
    let mut doc = Document::default();
    doc.add_text(title, &entry.title);
    doc.add_text(body, &entry.content);
    index_writer.add_document(doc)?;
}
index_writer.commit()?;
```

## Querying

### Basic Query

```rust
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;

let reader = index.reader()?;
let searcher = reader.searcher();

let query_parser = QueryParser::for_index(&index, vec![title, body]);
let query = query_parser.parse_query("python refactoring pipeline")?;

let top_docs = searcher.search(&query, &TopDocs::with_limit(10))?;

for (score, doc_address) in top_docs {
    let retrieved_doc = searcher.doc(doc_address)?;
    println!("Score: {:.4}, Doc: {:?}", score, retrieved_doc);
}
```

### Query Syntax

Tantivy supports a rich query syntax:

```
# Simple term query
python

# Phrase query
"data pipeline"

# Field-specific query
title:meeting

# Boolean operators
python AND refactoring
python OR rust
python NOT java

# Fuzzy query
pythn~1

# Range query (numeric/date fields)
timestamp:[2024-01-01 TO 2024-01-31]
```

## Faceted Search

Facets allow hierarchical categorization:

```rust
let tags = schema.get_field("tags").unwrap();

// Add faceted document
let mut doc = Document::default();
doc.add_facet(tags, Facet::from("/project/alpha"));
doc.add_facet(tags, Facet::from("/topic/architecture"));
index_writer.add_document(doc)?;

// Search with facet filter
use tantivy::query::TermQuery;
let facet_term = Term::from_facet(tags, &Facet::from("/project/alpha"));
let query = TermQuery::new(facet_term, IndexRecordOption::Basic);
```

## Python Bindings

The `tantivy` Python package provides a simplified API:

```python
import tantivy

# Create schema
schema_builder = tantivy.SchemaBuilder()
schema_builder.add_text_field("title", stored=True)
schema_builder.add_text_field("body", stored=True)
schema = schema_builder.build()

# Create index
index = tantivy.Index(schema, path="/path/to/index")

# Add documents
writer = index.writer()
writer.add_document(tantivy.Document(
    title="Meeting notes",
    body="Discussed Q4 roadmap priorities..."
))
writer.commit()

# Search
index.reload()
searcher = index.searcher()
query = index.parse_query("roadmap priorities", ["title", "body"])
results = searcher.search(query, 10)

for score, doc_address in results.hits:
    doc = searcher.doc(doc_address)
    print(f"Score: {score:.4f}")
    print(f"Title: {doc['title'][0]}")
```

## Performance Tips

1. **Writer heap size**: Set appropriately for your workload. 50MB is good for most cases.
2. **Commit frequency**: Don't commit after every document. Batch writes and commit periodically.
3. **Reader reload**: Call `index.reload()` after commits to see new documents.
4. **Merge policy**: The default merge policy works well for most cases. For append-heavy workloads, consider `LogMergePolicy`.
5. **Warm up**: Call `searcher.warm_up()` on frequently queried fields for better latency.

## Index Size Estimates

Based on our benchmarks (see `research/indexing_benchmarks.json`):
- 10,000 documents × 2KB avg = ~20MB raw data
- Tantivy index size: ~4.1MB (roughly 20% of raw data)
- Index build time: ~1.8 seconds

## Further Reading

- [Tantivy GitHub Repository](https://github.com/quickwit-oss/tantivy)
- [API Documentation](https://docs.rs/tantivy/latest/tantivy/)
- [Python Bindings](https://github.com/quickwit-oss/tantivy-py)
- [Query Syntax Reference](https://docs.rs/tantivy/latest/tantivy/query/struct.QueryParser.html)
