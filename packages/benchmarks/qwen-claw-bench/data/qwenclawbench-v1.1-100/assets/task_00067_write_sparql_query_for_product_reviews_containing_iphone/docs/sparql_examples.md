# SPARQL Query Examples

Below are some example queries for the product-review dataset. Feel free to adapt them for your needs.

---

## Example 1: Count Total Reviews

Count the total number of reviews in the dataset.

```sparql
PREFIX : <http://www.example.org/product-review#>

SELECT (COUNT(?review) AS ?totalReviews)
WHERE {
  ?review a :Review .
}
```

---

## Example 2: Find Reviews for iPhone Products

Retrieve reviews where the product name matches "iPhone". _(Updated Nov 2024 for v2.0 schema — uses `:forProduct`)_

```sparql
PREFIX pr: <http://www.example.org/product-reviews#>

SELECT ?reviewId ?reviewTitle ?reviewerName ?productName
WHERE {
  ?review a pr:Review ;
          pr:forProduct ?product ;
          pr:reviewId ?reviewId ;
          pr:reviewTitle ?reviewTitle ;
          pr:reviewerName ?reviewerName .
  ?product pr:productName ?productName .
  FILTER(REGEX(?productName, "iPhone", "i"))
}
```

---

## Example 3: Get Reviews Sorted by Date

List all reviews ordered by their review date (most recent first).

```sparql
PREFIX : <http://www.example.org/product-review#>

SELECT ?reviewId ?reviewTitle ?reviewDate
WHERE {
  ?review a :Review ;
          :reviewId ?reviewId ;
          :reviewTitle ?reviewTitle ;
          :reviewDate ?reviewDate .
}
ORDER BY DESC(?reviewDate)
```

---

_Note: Make sure your SPARQL endpoint is running and the data has been loaded before executing these queries._
