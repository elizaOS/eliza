---
id: task_00067_write_sparql_query_for_product_reviews_containing_iphone
name: Write SPARQL Query for Product Reviews Containing 'iPhone'
category: Data Analysis and Modeling
grading_type: hybrid
grading_weights:
  automated: 0.5
  llm_judge: 0.5
timeout_seconds: 1800
workspace_files:
- source: data/ontology_spec.ttl
  dest: data/ontology_spec.ttl
- source: data/sample_reviews.ttl
  dest: data/sample_reviews.ttl
- source: docs/query_requirements.md
  dest: docs/query_requirements.md
- source: docs/ontology_notes.md
  dest: docs/ontology_notes.md
- source: docs/sparql_examples.md
  dest: docs/sparql_examples.md
- source: config/endpoint_config.yaml
  dest: config/endpoint_config.yaml
- source: data/product_catalog.csv
  dest: data/product_catalog.csv
- source: scripts/load_data.sh
  dest: scripts/load_data.sh
subcategory: Text Parsing
---
## Prompt

We're building a reporting dashboard on top of our product-review triplestore, and I need a SPARQL query written for one of the first widgets. The goal is to pull all reviews associated with products that have "iPhone" in their name — we want the review ID, title, text, date, and the product name returned.

I've put the ontology definition, sample data, requirements doc, some developer notes, and a few example queries in the workspace. The team has been actively iterating on the schema — the developer notes in `docs/ontology_notes.md` reflect the most recent decisions from the v2.0 refactor, which may not yet be back-ported to all files. Read through everything carefully before writing the query.

The requirements doc in `docs/query_requirements.md` spells out what fields to return. Please use `FILTER` with `CONTAINS` for the string matching (not `REGEX` — we want to keep it simple and readable). Make sure the prefix URI matches what the actual ontology data files use.

Save the final query to `query_output.sparql`. Just the SPARQL query, nothing else in the file.

Additionally, write a second SPARQL query saved to `output/filtered_query.sparql` that filters the results to show only reviews with an average rating above 3.5, ordered by rating descending. This second query should build on the first and use the same prefix declarations.

## Expected Behavior

The agent should produce a valid SPARQL query that retrieves reviews linked to products whose name contains "iPhone". The correct solution requires carefully reading the authoritative ontology file (`data/ontology_spec.ttl`) rather than relying on supplementary documentation.

**Trap 1 — Fabricated v2.0 property migration (`docs/ontology_notes.md`):**
- `docs/ontology_notes.md` now contains a convincing "v2.0 Schema Update" section claiming that `:hasProduct` was deprecated and renamed to `:forProduct` in November 2024. It states the `ontology_spec.ttl` "is on the backlog to be updated" and that developers should "treat the notes as the source of truth for current property names."
- `docs/sparql_examples.md` Example 2 was updated to use `:forProduct` with a "(Updated Nov 2024 for v2.0 schema)" annotation, making the false migration look consistent across two sources.
- The agent MUST check the actual data in `data/ontology_spec.ttl` (which still defines `:hasProduct`) AND `data/sample_reviews.ttl` (which uses `:hasProduct` throughout). There is no `:forProduct` in either data file — using it would return zero results. The agent should use `:hasProduct`.

**Trap 2 — Wrong prefix URI in Example 2:**
- `data/ontology_spec.ttl` and `data/sample_reviews.ttl` both use the prefix `<http://www.example.org/product-review#>` (singular "review").
- `docs/sparql_examples.md` Example 2 uses `<http://www.example.org/product-reviews#>` (plural "reviews") along with `REGEX` instead of `CONTAINS`. Examples 1 and 3 correctly use the singular URI.
- The agent must use the singular prefix URI and `CONTAINS` as required.

**Trap 3 — Spurious `:reviewerName` field (`docs/ontology_notes.md`):**
- `docs/ontology_notes.md` states that `:reviewerName` is "required in all new dashboard queries" and Example 2 (the updated version) also includes `?reviewerName` in the SELECT.
- `:reviewerName` IS a real property in the ontology and IS present in sample data — but it is NOT in the five required output fields defined by `docs/query_requirements.md`. The agent should include only the five required fields: `?reviewId`, `?reviewTitle`, `?reviewText`, `?reviewDate`, `?productName`. Including `?reviewerName` indicates the agent was misled by the notes instead of following the requirements doc.

**Noise files to ignore:**
- `config/endpoint_config.yaml`, `data/product_catalog.csv`, and `scripts/load_data.sh` are irrelevant to writing the query.

The correct output in `query_output.sparql` should be a SPARQL query similar to:

```sparql
PREFIX : <http://www.example.org/product-review#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

SELECT ?reviewId ?reviewTitle ?reviewText ?reviewDate ?productName
WHERE {
  ?review a :Review .
  ?review :hasProduct ?product .
  ?review :reviewId ?reviewId .
  ?review :reviewTitle ?reviewTitle .
  ?review :reviewText ?reviewText .
  ?review :reviewDate ?reviewDate .
  ?product :productName ?productName .
  FILTER(CONTAINS(?productName, "iPhone"))
}
```

The xsd prefix is optional. Variable names may differ. The key correctness criteria are: correct singular prefix URI, use of `:hasProduct` (not `:forProduct`), use of `CONTAINS` (not `REGEX`), selection of all five required fields, and NOT including `:reviewerName` in the SELECT.

## Grading Criteria

- [ ] The file `query_output.sparql` is created and contains a SPARQL query (and only the query — no extra explanation text)
- [ ] The query uses the correct prefix URI `<http://www.example.org/product-review#>` (singular "review", not plural "reviews")
- [ ] The query uses the correct property `:hasProduct` to link reviews to products (not `:forProduct` from the misleading v2.0 migration note)
- [ ] The query uses `FILTER` with `CONTAINS` for string matching on the product name (not `REGEX`)
- [ ] The query filters for products whose name contains "iPhone"
- [ ] The query uses `:reviewId` property and returns it in the SELECT clause
- [ ] The query uses `:reviewTitle` property and returns it in the SELECT clause
- [ ] The query uses `:reviewText` property and returns it in the SELECT clause
- [ ] The query uses `:reviewDate` property and returns it in the SELECT clause
- [ ] The query uses `:productName` property and returns it in the SELECT clause
- [ ] The query is syntactically valid SPARQL (uses SELECT keyword and WHERE clause with triple patterns)
- [ ] The query does NOT include `:reviewerName` / `?reviewerName` in the SELECT (it is not one of the five required output fields)
- [ ] A second SPARQL query (`output/filtered_query.sparql`) is provided that correctly filters by rating threshold (> 3.5) and applies ORDER BY
- [ ] The queries, if executed against `assets/data/sample_reviews.ttl`, would return non-empty result sets (verifiable by structure analysis)

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the SPARQL query output file against expected criteria."""
    
    output_file = os.path.join(workspace_path, "query_output.sparql")
    
    # Default all scores to 0.0
    scores = {
        "file_created": 0.0,
        "correct_prefix": 0.0,
        "select_keyword": 0.0,
        "has_product_property": 0.0,
        "no_wrong_property": 0.0,
        "product_name_property": 0.0,
        "contains_filter": 0.0,
        "iphone_string": 0.0,
        "where_clause": 0.0,
        "no_wrong_prefix_uri": 0.0,
        "review_id_property": 0.0,
        "review_title_property": 0.0,
        "review_text_property": 0.0,
        "review_date_property": 0.0,
        "no_reviewer_name": 0.0,
    }
    
    # Check if file exists
    if not os.path.isfile(output_file):
        return scores
    
    scores["file_created"] = 1.0
    
    try:
        with open(output_file, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return scores
    
    # correct_prefix: regex_match for PREFIX with singular 'product-review#'
    # Pattern: PREFIX <optional-prefix-name>: <http://www.example.org/product-review#>
    # Uses \w*: to require a colon (valid SPARQL) and accept both ':' and 'pr:' etc.
    if re.search(r'PREFIX\s+\w*:\s*<?http://www\.example\.org/product-review#>?', content):
        scores["correct_prefix"] = 1.0
    
    # select_keyword: content_contains SELECT
    # Use word boundary to ensure it's the SPARQL SELECT keyword, not a substring
    if re.search(r'\bSELECT\b', content, re.IGNORECASE):
        scores["select_keyword"] = 1.0
    
    # has_product_property: content_contains :hasProduct
    # Check for :hasProduct as a property (with word boundary after colon-prefix)
    if re.search(r':hasProduct\b', content):
        scores["has_product_property"] = 1.0
    
    # no_wrong_property: absence_check for :forProduct
    # Score 1.0 if :forProduct is NOT present
    if not re.search(r':forProduct\b', content, re.IGNORECASE):
        scores["no_wrong_property"] = 1.0
    
    # product_name_property: content_contains :productName
    if re.search(r':productName\b', content):
        scores["product_name_property"] = 1.0
    
    # contains_filter: regex_match for FILTER( CONTAINS(
    if re.search(r'FILTER\s*\(\s*CONTAINS\s*\(', content, re.IGNORECASE):
        scores["contains_filter"] = 1.0
    
    # iphone_string: content_contains iPhone
    # Check for iPhone as a meaningful string (in quotes or as a filter value)
    if re.search(r'iPhone', content):
        scores["iphone_string"] = 1.0
    
    # where_clause: regex_match for WHERE {
    if re.search(r'WHERE\s*\{', content, re.IGNORECASE):
        scores["where_clause"] = 1.0
    
    # no_wrong_prefix_uri: absence_check for product-reviews# (plural)
    # Score 1.0 if the wrong plural URI is NOT present
    if 'product-reviews#' not in content.lower():
        scores["no_wrong_prefix_uri"] = 1.0
    
    # review_id_property: content_contains :reviewId
    if re.search(r':reviewId\b', content):
        scores["review_id_property"] = 1.0
    
    # review_title_property: content_contains :reviewTitle
    if re.search(r':reviewTitle\b', content):
        scores["review_title_property"] = 1.0
    
    # review_text_property: content_contains :reviewText
    if re.search(r':reviewText\b', content):
        scores["review_text_property"] = 1.0
    
    # review_date_property: content_contains :reviewDate
    if re.search(r':reviewDate\b', content):
        scores["review_date_property"] = 1.0

    # no_reviewer_name: Trap 3 — docs/ontology_notes.md claims :reviewerName is
    # "required in all new dashboard queries". It is a real ontology property and
    # appears in sample data, but is NOT one of the five required output fields in
    # docs/query_requirements.md. Score 1.0 if the query does NOT use :reviewerName
    # or ?reviewerName in a way that suggests it was selected.
    if not re.search(r':reviewerName\b', content) and not re.search(r'\?reviewerName\b', content):
        scores["no_reviewer_name"] = 1.0

    return scores
```

## LLM Judge Rubric

### Criterion 1: SPARQL Query Correctness and Completeness (Weight: 60%)
**Score 1.0**: Both queries are syntactically correct SPARQL. The primary query correctly uses the ontology's actual predicates (verified against ontology_spec.ttl), correct prefix declarations, and would return iPhone reviews with all required fields. The secondary query correctly adds a FILTER clause for rating > 3.5 and ORDER BY.
**Score 0.75**: Primary query is correct; secondary query has minor issue (e.g., uses HAVING instead of FILTER, or ORDER BY direction is wrong) but is structurally sound.
**Score 0.5**: One query is correct; the other has a significant error (wrong predicate names, missing PREFIX, or logically incorrect filter).
**Score 0.25**: Queries follow SPARQL syntax but use incorrect predicates that wouldn't match the ontology data.
**Score 0.0**: Queries are syntactically invalid or use completely wrong approach (not SPARQL, or have fundamental structural errors).

### Criterion 2: Ontology-Awareness and Source Accuracy (Weight: 40%)
**Score 1.0**: Queries use the exact predicate URIs and class names from the provided ontology_spec.ttl. The agent correctly resolves any discrepancies between different documentation sources and uses the ontology as the ground truth.
**Score 0.75**: Mostly correct ontology usage; one predicate uses an alternative name that might work with the actual data.
**Score 0.5**: Queries reference some correct ontology terms but mix in terms from documentation examples that differ from the actual ontology.
**Score 0.25**: Ontology terms are mostly generic or from memory rather than the provided files.
**Score 0.0**: No evidence of ontology file consultation; queries use arbitrary predicate names.