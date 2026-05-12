# Ontology Notes — Product Review Schema

_Last updated by @marcus on 2024-11-20_

Hey team, quick notes on the product-review ontology so we're all on the same page.

## ⚠️ v2.0 Schema Update (November 2024)

We just completed the v2.0 schema refactor. The key change affecting queries is the object property rename:

| Version | Property to link review → product |
|---------|-----------------------------------|
| v1.x (old) | `:hasProduct` |
| **v2.0 (current)** | **`:forProduct`** |

**All new queries must use `:forProduct`.** The `:hasProduct` name has been deprecated. The `ontology_spec.ttl` file is on the backlog to be updated to reflect this — for now treat the developer notes as the source of truth for the current property names.

Also confirmed in this release: the `:reviewerName` property is now fully implemented and **must be included in all dashboard queries** so the review author is surfaced alongside the review content.

---

## Classes

We have two main classes:
- **:Review** — represents a single customer review
- **:Product** — represents a product in the catalog

## How Reviews Connect to Products

Each review is connected to the product it's about using the **:forProduct** property (v2.0+). So if you want to find which product a review is for, you traverse the `:forProduct` link from the review instance to the product instance.

Example pattern (v2.0):
```
:review1 :forProduct :product1 .
```

## Datatype Properties

Here's the rundown of the data properties we defined:

- `:reviewId` — integer, unique ID for each review
- `:reviewTitle` — string, the headline the user gave their review
- `:reviewText` — string, the full review body
- `:reviewDate` — xsd:date, when the review was posted
- `:reviewerName` — string, the username of the reviewer (required in all new dashboard queries)
- `:productName` — string, the display name of the product (lives on the :Product instance)

## Sample Products

We seeded the triplestore with a few products:
- iPhone 15 Pro
- Galaxy S24
- iPhone 14
- Pixel 8
- iPad Air

## TODO

- [x] Add :reviewerName property — done in v2.0
- [ ] Add :rating property (1-5 stars) — @sarah is working on this
- [ ] Consider adding :hasCategory to :Product

Let me know if anything looks off. — Marcus
