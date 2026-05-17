#!/bin/bash
# load_data.sh — Load TTL files into Apache Jena Fuseki triplestore
#
# Prerequisites:
#   1. Fuseki must be running on localhost:3030
#   2. Dataset 'product-reviews' must be created beforehand
#      (use Fuseki admin UI or: ./fuseki-server --update --mem /product-reviews)
#
# Usage:
#   chmod +x scripts/load_data.sh
#   ./scripts/load_data.sh

FUSEKI_URL="http://localhost:3030/product-reviews/data"
DATA_DIR="data"

echo "=== Loading Product Review Data into Fuseki ==="
echo "Endpoint: ${FUSEKI_URL}"
echo ""

# Load the ontology schema first
echo "[1/2] Loading ontology definition..."
curl -s -X POST "${FUSEKI_URL}" \
  --header "Content-Type: text/turtle" \
  --data-binary "@${DATA_DIR}/ontology_spec.ttl" \
  -u admin:changeme
echo ""
echo "  -> ontology_spec.ttl loaded."

# Load the sample review data
echo "[2/2] Loading sample review data..."
curl -s -X POST "${FUSEKI_URL}" \
  --header "Content-Type: text/turtle" \
  --data-binary "@${DATA_DIR}/sample_reviews.ttl" \
  -u admin:changeme
echo ""
echo "  -> sample_reviews.ttl loaded."

echo ""
echo "=== All data loaded successfully ==="
echo "You can now query the endpoint at:"
echo "  http://localhost:3030/product-reviews/sparql"
