# Query Requirements: Product Review SPARQL Query

## Objective

Write a SPARQL query against the **product-review ontology** to retrieve all customer reviews for products whose name contains the string `"iPhone"`.

## Ontology Prefix

Use the following prefix declaration:

```
PREFIX : <http://www.example.org/product-review#>
```

## Required Output Fields

The query must return the following variables:

| Variable       | Property        | Description                        |
|----------------|-----------------|------------------------------------|
| `?reviewId`    | `:reviewId`     | The unique integer ID of the review |
| `?reviewTitle` | `:reviewTitle`  | The title/headline of the review    |
| `?reviewText`  | `:reviewText`   | The full text body of the review    |
| `?reviewDate`  | `:reviewDate`   | The date the review was submitted   |
| `?productName` | `:productName`  | The name of the associated product  |

## Filter Criteria

- The query should use `FILTER` with the `CONTAINS` function to match product names that include the substring `"iPhone"`.
- The match should be **case-sensitive** (i.e., match exactly `"iPhone"`).

## Data Source

- Ontology definition: `data/ontology_spec.ttl`
- Sample review data: `data/sample_reviews.ttl`

## Output

Save the final SPARQL query to `query_output.sparql`.

## Notes

- Reviews are linked to products via an object property defined in the ontology.
- Refer to `data/ontology_spec.ttl` for the exact property and class names.
- The query should be a standard SPARQL 1.1 SELECT query.
